// ─── Google HTTP transport for OAuth + Search Console ───
// Everything that speaks to Google lives behind `GoogleTransport` so the
// orchestration around it (state, PKCE, refresh, pagination, retries) can be
// exercised deterministically, and so the live code path is a thin, auditable
// translation of Google's documented wire format.
//
// Live Google calls are NOT exercised in this repository's gates: they need a
// real client consent, which is recorded as a BLOCKED gate (GSC-004/GSC-005).

import type { GscMetricRow, GscSyncWindow } from "./types.ts";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_SITES_ENDPOINT = "https://www.googleapis.com/webmasters/v3/sites";
export const SEARCH_ANALYTICS_ENDPOINT =
  "https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query";

/** Least-privilege scope: read Search Console data, never modify it. */
export const GSC_READONLY_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly openid email profile";

export interface GoogleTokenResponse {
  accessToken: string;
  /** Absent on refresh responses that do not rotate the refresh token. */
  refreshToken?: string;
  expiresIn: number;
  scope: string;
  tokenId?: string;
}

export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export interface SearchAnalyticsRequest extends GscSyncWindow {
  dimensions: string[];
  rowLimit: number;
  startRow: number;
}

export interface SearchAnalyticsResponse {
  rows: GscMetricRow[];
  aggregationType: string;
}

export type GscErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "NETWORK"
  | "UNKNOWN";

/**
 * A transport-level failure with an explicit retry decision. `retryable` is
 * computed once, here, so job orchestration never guesses from message text.
 */
export class GscApiError extends Error {
  readonly code: GscErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: GscErrorCode, message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "GscApiError";
    this.code = code;
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export interface GoogleTransport {
  exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse>;
  refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse>;
  /** Best-effort revocation: Google answers 200 even for unknown tokens. */
  revokeToken(input: {
    token: string;
    clientId: string;
    clientSecret: string;
  }): Promise<void>;
  listSites(accessToken: string): Promise<GscSiteEntry[]>;
  querySearchAnalytics(
    accessToken: string,
    property: string,
    request: SearchAnalyticsRequest,
  ): Promise<SearchAnalyticsResponse>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Map an HTTP failure to a typed, retry-classified error. */
export function classifyHttpError(status: number, bodyText: string): GscApiError {
  const detail = bodyText.slice(0, 300);
  if (status === 401) {
    return new GscApiError("UNAUTHORIZED", "Google rejected the access token.", {
      retryable: false,
      status,
    });
  }
  if (status === 404) {
    return new GscApiError("NOT_FOUND", `Google has no such resource: ${detail}`, {
      retryable: false,
      status,
    });
  }
  if (status === 429) {
    return new GscApiError("RATE_LIMITED", "Google rate limit exceeded.", {
      retryable: true,
      status,
    });
  }
  if (status === 403) {
    // Google signals API quota exhaustion with a 403 + reason, not a 429.
    const quota = /quotaExceeded|rateLimitExceeded|userRateLimitExceeded/i.test(bodyText);
    return new GscApiError(
      quota ? "QUOTA_EXCEEDED" : "FORBIDDEN",
      quota ? "Google API quota exhausted." : `Google denied the request: ${detail}`,
      { retryable: quota, status },
    );
  }
  if (status === 400) {
    // Google reports a revoked or expired grant as 400 + `invalid_grant` —
    // that is an authorization failure wearing a bad-request costume.
    if (/invalid_grant/i.test(bodyText)) {
      return new GscApiError("UNAUTHORIZED", "Google rejected the grant (invalid_grant).", {
        retryable: false,
        status,
      });
    }
    return new GscApiError("INVALID_ARGUMENT", `Google rejected the request: ${detail}`, {
      retryable: false,
      status,
    });
  }
  if (status >= 500) {
    return new GscApiError("UNKNOWN", `Google server error ${status}.`, {
      retryable: true,
      status,
    });
  }
  return new GscApiError("UNKNOWN", `Unexpected Google response ${status}: ${detail}`, {
    retryable: false,
    status,
  });
}

async function readError(response: Response): Promise<never> {
  const text = await response.text().catch(() => "");
  throw classifyHttpError(response.status, text);
}

async function postForm(url: string, form: Record<string, string>, fetchFn: FetchLike): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  } catch (err) {
    throw new GscApiError("NETWORK", `Google unreachable: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!response.ok) await readError(response);
  const body: unknown = await response.json().catch(() => ({}));
  return body;
}

/** Production transport. `fetchFn` is injectable so wire shapes stay testable. */
export class HttpGoogleTransport implements GoogleTransport {
  private readonly fetchFn: FetchLike;

  constructor(fetchFn?: FetchLike) {
    this.fetchFn = fetchFn ?? ((url, init) => fetch(url, init));
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse> {
    const body = await postForm(
      GOOGLE_TOKEN_ENDPOINT,
      {
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: "authorization_code",
        // PKCE: proves the exchange comes from the client that built the
        // authorize URL, neutralising a stolen authorization code.
        code_verifier: input.codeVerifier,
      },
      this.fetchFn,
    );
    return toTokenResponse(body, true);
  }

  async refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse> {
    const body = await postForm(
      GOOGLE_TOKEN_ENDPOINT,
      {
        refresh_token: input.refreshToken,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
      },
      this.fetchFn,
    );
    // Refresh responses commonly omit `refresh_token`; callers keep the old one.
    return toTokenResponse(body, false);
  }

  async revokeToken(input: {
    token: string;
    clientId: string;
    clientSecret: string;
  }): Promise<void> {
    try {
      await postForm(
        GOOGLE_REVOKE_ENDPOINT,
        { token: input.token, client_id: input.clientId },
        this.fetchFn,
      );
    } catch (err) {
      // Revocation is best-effort at Google's side; local material is deleted
      // regardless. Only a transport-level failure is worth surfacing.
      if (err instanceof GscApiError && err.code === "NETWORK") throw err;
    }
  }

  async listSites(accessToken: string): Promise<GscSiteEntry[]> {
    let response: Response;
    try {
      response = await this.fetchFn(GOOGLE_SITES_ENDPOINT, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      throw new GscApiError("NETWORK", `Google unreachable: ${(err as Error).message}`, {
        retryable: true,
      });
    }
    if (!response.ok) await readError(response);
    const body = (await response.json()) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
    return (body.siteEntry ?? [])
      .filter((entry): entry is { siteUrl: string; permissionLevel?: string } => Boolean(entry.siteUrl))
      .map((entry) => ({
        siteUrl: entry.siteUrl,
        permissionLevel: entry.permissionLevel ?? "siteOwner",
      }));
  }

  async querySearchAnalytics(
    accessToken: string,
    property: string,
    request: SearchAnalyticsRequest,
  ): Promise<SearchAnalyticsResponse> {
    const url = SEARCH_ANALYTICS_ENDPOINT.replace("{siteUrl}", encodeURIComponent(property));
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          startDate: request.startDate,
          endDate: request.endDate,
          dimensions: request.dimensions,
          rowLimit: request.rowLimit,
          startRow: request.startRow,
        }),
      });
    } catch (err) {
      throw new GscApiError("NETWORK", `Google unreachable: ${(err as Error).message}`, {
        retryable: true,
      });
    }
    if (!response.ok) await readError(response);
    const body = (await response.json().catch(() => ({}))) as {
      rows?: unknown[];
      responseAggregationType?: string;
    };
    return {
      rows: (body.rows ?? []).map((row) => toMetricRow(row)),
      aggregationType: body.responseAggregationType ?? "aggregateByDate",
    };
  }
}

function toTokenResponse(body: unknown, requireRefresh: boolean): GoogleTokenResponse {
  const record = (body ?? {}) as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (!accessToken) {
    const error = typeof record.error === "string" ? record.error : "malformed_token_response";
    throw new GscApiError(
      error.includes("invalid_grant") ? "UNAUTHORIZED" : "INVALID_ARGUMENT",
      `Token endpoint did not return an access token (${error}).`,
      { retryable: false },
    );
  }
  const refreshToken = typeof record.refresh_token === "string" ? record.refresh_token : undefined;
  if (requireRefresh && !refreshToken) {
    throw new GscApiError(
      "INVALID_ARGUMENT",
      "Google did not return a refresh token; ensure prompt=consent and offline access.",
      { retryable: false },
    );
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 3599;
  return {
    accessToken,
    refreshToken,
    expiresIn,
    scope: typeof record.scope === "string" ? record.scope : "",
    tokenId: typeof record.id_token === "string" ? record.id_token : undefined,
  };
}

/** Coerce a wire value to a finite number; anything else becomes 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Google returns `{keys:[...], clicks, impressions, ctr, position, ...}`. */
function toMetricRow(raw: unknown): GscMetricRow {
  const record = (raw ?? {}) as Record<string, unknown>;
  const keys = Array.isArray(record.keys) ? record.keys.map((k) => String(k)) : [];
  const [date = "", query = "", page = "", country = "", device = ""] = keys;
  return {
    date,
    query,
    page,
    country,
    device: device.toUpperCase(),
    clicks: num(record.clicks),
    impressions: num(record.impressions),
    ctr: num(record.ctr),
    position: num(record.position),
  };
}
