// GSC wire contract — HttpGoogleTransport against documented Google response
// shapes, with the fetch function injected so nothing leaves this process.
//
// CLAIM: the live transport is a thin, auditable translation of Google's wire
// format: token exchange/refresh parse exactly the documented fields, Search
// Analytics rows arrive with all five dimensions, and every HTTP failure is
// classified ONCE into a typed, retry-decided error (quota exhaustion is
// recognised as the 403+reason shape Google actually uses).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHttpError,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  HttpGoogleTransport,
} from "./google-transport.ts";
import { GscApiError } from "./google-transport.ts";
import type { GscMetricRow } from "./types.ts";

interface Recorded {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

function stubFetch(
  responses: { status: number; body: unknown }[],
): { fetchFn: (url: string, init?: RequestInit) => Promise<Response>; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
    });
    const next = queue.shift() ?? queue.at(-1) ?? { status: 200, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchFn, calls };
}

void describe("GSC wire — error classification (retry decided once, here)", () => {
  void it("maps status codes to typed, retry-classified failures", () => {
    assert.deepEqual(classify(401, "{}"), { code: "UNAUTHORIZED", retryable: false });
    assert.deepEqual(classify(404, "{}"), { code: "NOT_FOUND", retryable: false });
    assert.deepEqual(classify(429, "{}"), { code: "RATE_LIMITED", retryable: true });
    assert.deepEqual(classify(403, '{"error":{"errors":[{"reason":"quotaExceeded"}]}}'), {
      code: "QUOTA_EXCEEDED",
      retryable: true,
    });
    assert.deepEqual(classify(403, '{"error":{"errors":[{"reason":"forbidden"}]}}'), {
      code: "FORBIDDEN",
      retryable: false,
    });
    assert.deepEqual(classify(400, "{}"), { code: "INVALID_ARGUMENT", retryable: false });
    assert.deepEqual(classify(503, "oops"), { code: "UNKNOWN", retryable: true });
  });

  function classify(status: number, body: string): { code: string; retryable: boolean } {
    const err = classifyHttpError(status, body);
    return { code: err.code, retryable: err.retryable };
  }
});

void describe("GSC wire — OAuth token endpoints", () => {
  void it("exchanges a code with the PKCE verifier and parses the token response", async () => {
    const { fetchFn, calls } = stubFetch([
      {
        status: 200,
        body: {
          access_token: "ya29.wire",
          refresh_token: "1//wire-refresh",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
          id_token: "header.payload.sig",
        },
      },
    ]);
    const transport = new HttpGoogleTransport(fetchFn);
    const tokens = await transport.exchangeCode({
      code: "auth-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "http://localhost:3000/cb",
      clientId: "client",
      clientSecret: "cs-fixture",
    });

    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, GOOGLE_TOKEN_ENDPOINT);
    const form = new URLSearchParams(call.body);
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "auth-code");
    assert.equal(form.get("code_verifier"), "pkce-verifier");
    assert.equal(form.get("redirect_uri"), "http://localhost:3000/cb");
    assert.equal(tokens.accessToken, "ya29.wire");
    assert.equal(tokens.refreshToken, "1//wire-refresh");
    assert.equal(tokens.expiresIn, 3599);
  });

  void it("accepts a refresh response without a rotated refresh token", async () => {
    const { fetchFn } = stubFetch([
      { status: 200, body: { access_token: "ya29.new", expires_in: 3599 } },
    ]);
    const transport = new HttpGoogleTransport(fetchFn);
    const tokens = await transport.refreshAccessToken({
      refreshToken: "1//old",
      clientId: "client",
      clientSecret: "cs-fixture",
    });
    assert.equal(tokens.accessToken, "ya29.new");
    assert.equal(tokens.refreshToken, undefined, "absent rotation keeps the old token valid");
  });

  void it("fails explicitly when an authorization response has no refresh token", async () => {
    const { fetchFn } = stubFetch([
      { status: 200, body: { access_token: "ya29.only", expires_in: 3599 } },
    ]);
    const transport = new HttpGoogleTransport(fetchFn);
    await assert.rejects(
      transport.exchangeCode({
        code: "c",
        codeVerifier: "v",
        redirectUri: "r",
        clientId: "client",
        clientSecret: "cs-fixture",
      }),
      (err: unknown) => err instanceof GscApiError && err.code === "INVALID_ARGUMENT",
    );
  });

  void it("classifies invalid_grant as UNAUTHORIZED (revoked refresh token)", async () => {
    const { fetchFn } = stubFetch([
      { status: 400, body: { error: "invalid_grant", error_description: "Token has been revoked." } },
    ]);
    const transport = new HttpGoogleTransport(fetchFn);
    await assert.rejects(
      transport.refreshAccessToken({
        refreshToken: "1//revoked",
        clientId: "client",
        clientSecret: "cs-fixture",
      }),
      (err: unknown) => err instanceof GscApiError && err.code === "UNAUTHORIZED" && !err.retryable,
    );
  });

  void it("posts revocation to Google's revoke endpoint and swallows non-network errors", async () => {
    const { fetchFn, calls } = stubFetch([{ status: 200, body: {} }]);
    const transport = new HttpGoogleTransport(fetchFn);
    await transport.revokeToken({ token: "1//revoke-me", clientId: "client", clientSecret: "x" });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.url, GOOGLE_REVOKE_ENDPOINT);
    assert.match(call.body, /token=1%2F%2Frevoke-me/);
  });
});

void describe("GSC wire — Search Console endpoints", () => {
  void it("lists sites with their permission levels", async () => {
    const { fetchFn, calls } = stubFetch([
      {
        status: 200,
        body: {
          siteEntry: [
            { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
            { siteUrl: "https://example.com/blog/", permissionLevel: "siteFullUser" },
            { permissionLevel: "siteOwner" }, // no URL: unusable, dropped
          ],
        },
      },
    ]);
    const transport = new HttpGoogleTransport(fetchFn);
    const sites = await transport.listSites("ya29.wire");
    assert.deepEqual(sites, [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://example.com/blog/", permissionLevel: "siteFullUser" },
    ]);
    assert.match(calls[0]?.headers.authorization ?? "", /^Bearer /, "the grant, not a secret");
  });

  void it("requests all five dimensions and parses Google's keys arrays", async () => {
    const { fetchFn, calls } = stubFetch([
      {
        status: 200,
        body: {
          rows: [
            {
              keys: ["2026-09-15", "evidence seo", "https://example.com/evidence", "fra", "DESKTOP"],
              clicks: 4,
              impressions: 40,
              ctr: 0.1,
              position: 3.5,
            },
            {
              keys: ["2026-09-16", "mobile query", "https://example.com/m", "usa", "mobile"],
              clicks: "1", // untrusted wire: coerced, never NaN
              impressions: 9,
              ctr: 0.111,
              position: 8,
            },
          ],
          responseAggregationType: "byProperty",
        },
      },
    ]);
    const transport = new HttpGoogleTransport(fetchFn);
    const response = await transport.querySearchAnalytics(
      "ya29.wire",
      "sc-domain:example.com",
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        dimensions: ["date", "query", "page", "country", "device"],
        rowLimit: 25_000,
        startRow: 0,
      },
    );

    const requestBody = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(requestBody, {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["date", "query", "page", "country", "device"],
      rowLimit: 25_000,
      startRow: 0,
    });
    assert.match(calls[0]?.url ?? "", /sc-domain%3Aexample\.com/);
    assert.equal(response.aggregationType, "byProperty");
    assert.deepEqual(response.rows[0], {
      date: "2026-09-15",
      query: "evidence seo",
      page: "https://example.com/evidence",
      country: "fra",
      device: "DESKTOP",
      clicks: 4,
      impressions: 40,
      ctr: 0.1,
      position: 3.5,
    } satisfies GscMetricRow);
    const second = response.rows[1];
    assert.ok(second);
    assert.equal(second.device, "MOBILE", "device is normalised exactly once");
    assert.equal(second.clicks, 0, "a junk numeric wire value degrades to 0, not NaN");
  });

  void it("surfaces transport failures as retryable NETWORK errors", async () => {
    const transport = new HttpGoogleTransport(() => Promise.reject(new Error("ECONNREFUSED")));
    await assert.rejects(
      transport.listSites("ya29.wire"),
      (err: unknown) => err instanceof GscApiError && err.code === "NETWORK" && err.retryable,
    );
  });
});
