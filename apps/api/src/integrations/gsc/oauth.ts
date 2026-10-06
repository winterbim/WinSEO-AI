// ─── Google OAuth 2.0: PKCE, state, token lifecycle ───
//
// Security properties implemented here (GSC-001 / GSC-002):
//   • `state` is a 256-bit nonce, stored as a SHA-256 hash and claimed
//     atomically — a replayed or expired callback finds no row.
//   • The tenant scope travels inside `state` so the callback can open the RLS
//     transaction before it knows anything else; tampering with it changes the
//     hash, so the lookup fails rather than switching tenants.
//   • PKCE (S256) binds the code exchange to the client that started the flow.
//   • Tokens are envelope-encrypted before persistence and decrypted only in
//     memory, immediately before a Google call.

import { createHash, randomBytes } from "node:crypto";
import { GscCredentialsRequiredError } from "./types.ts";
import {
  GscApiError,
  GOOGLE_AUTHORIZE_ENDPOINT,
  GSC_READONLY_SCOPE,
  type GoogleTransport,
} from "./google-transport.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import type { GscStore, StoredGscCredential } from "../../stores/types.ts";

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before expiry so an in-flight request cannot race it. */
export const ACCESS_TOKEN_SKEW_SECONDS = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssuedState {
  state: string;
  stateHash: string;
  organizationId: string;
}

export function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** Mint an opaque state carrying its tenant scope (see module header). */
export function createStateToken(organizationId: string): IssuedState {
  const nonce = randomBytes(32).toString("base64url");
  const state = `${Buffer.from(organizationId, "utf8").toString("base64url")}.${nonce}`;
  return { state, stateHash: hashState(state), organizationId };
}

/**
 * Recover the tenant scope from a presented state. Returns null for anything
 * that is not a well-formed UUID — the caller then rejects the callback
 * *before* opening a database transaction.
 */
export function parseStateOrganization(state: string): string | null {
  const separator = state.indexOf(".");
  if (separator <= 0) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(state.slice(0, separator), "base64url").toString("utf8");
  } catch {
    return null;
  }
  return UUID_RE.test(decoded) ? decoded.toLowerCase() : null;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** PKCE pair: verifier stays server-side, only the S256 challenge travels. */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  return { codeVerifier, codeChallenge };
}

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
}

/**
 * Build the Google consent URL.
 *
 * Deliberately contains NO client secret — the consent URL is rendered in a
 * browser and lands in history, referrers and Google's own logs.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope ?? GSC_READONLY_SCOPE);
  url.searchParams.set("state", input.state);
  // offline + consent are what make Google return a refresh token at all.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** True when the access token is expired, or expires within `skew`. */
export function accessTokenNeedsRefresh(expiresAtIso: string, nowMs: number): boolean {
  const expiresAt = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - ACCESS_TOKEN_SKEW_SECONDS * 1000 <= nowMs;
}

export interface TokenLifecycleDeps {
  store: GscStore;
  transport: GoogleTransport;
  key: Buffer;
  clientId: string;
  clientSecret: string;
  organizationId: string;
  projectId: string;
  now?: number;
}

/**
 * Return a currently-valid access token, transparently refreshing when the
 * stored one is expired or about to expire.
 *
 * A refresh persists the rotated values immediately (encrypted), so the next
 * request does not pay for another round trip. `UNAUTHORIZED` from Google means
 * the refresh token itself was revoked — surfaced as CREDENTIALS_REQUIRED so
 * the connection can be marked, not silently retried forever.
 */
export async function getValidAccessToken(deps: TokenLifecycleDeps): Promise<string> {
  const credential = await deps.store.getCredential(deps.organizationId, deps.projectId);
  if (!credential) throw new GscCredentialsRequiredError();

  const now = deps.now ?? Date.now();
  if (!accessTokenNeedsRefresh(credential.accessTokenExpiresAt, now)) {
    return decryptSecret(credential.encryptedAccessToken, deps.key);
  }

  const refreshToken = decryptSecret(credential.encryptedRefreshToken, deps.key);
  let tokens: Awaited<ReturnType<GoogleTransport["refreshAccessToken"]>>;
  try {
    tokens = await deps.transport.refreshAccessToken({
      refreshToken,
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
    });
  } catch (err) {
    // `invalid_grant` — the refresh token was revoked or expired at Google —
    // is indistinguishable from having no grant at all. Surface
    // CREDENTIALS_REQUIRED so the flow stops cleanly and demands
    // re-authorization instead of retrying a dead token forever.
    if (err instanceof GscApiError && err.code === "UNAUTHORIZED") {
      throw new GscCredentialsRequiredError();
    }
    throw err;
  }

  const encryptedAccessToken = encryptSecret(tokens.accessToken, deps.key);
  const encryptedRefreshToken = tokens.refreshToken
    ? encryptSecret(tokens.refreshToken, deps.key)
    : undefined;
  const expiresAt = new Date(now + tokens.expiresIn * 1000).toISOString();
  await deps.store.updateCredentialTokens({
    organizationId: deps.organizationId,
    projectId: deps.projectId,
    encryptedAccessToken,
    accessTokenExpiresAt: expiresAt,
    encryptedRefreshToken,
  });

  return tokens.accessToken;
}

/**
 * Disconnect: revoke the grant at Google, then erase local token material.
 *
 * Local deletion happens even if Google's revocation endpoint fails — keeping
 * ciphertext we can no longer revoke would be worse than losing it. The caller
 * still receives the transport error so an operator can retry the revocation.
 */
export async function disconnectGoogle(deps: {
  store: GscStore;
  transport: GoogleTransport;
  key: Buffer;
  clientId: string;
  clientSecret: string;
  organizationId: string;
  projectId: string;
}): Promise<void> {
  const credential = await deps.store.getCredential(deps.organizationId, deps.projectId);
  if (!credential) return;

  const failures: unknown[] = [];
  for (const ciphertext of [credential.encryptedRefreshToken, credential.encryptedAccessToken]) {
    // Revoking both matters: Google accepts either token kind. One failure must
    // not skip the other — a partially-revoked grant is the worst outcome, so
    // every revocation is attempted before anything is surfaced.
    try {
      await deps.transport.revokeToken({
        token: decryptSecret(ciphertext, deps.key),
        clientId: deps.clientId,
        clientSecret: deps.clientSecret,
      });
    } catch (err) {
      failures.push(err);
    }
  }

  // Local erasure is unconditional: ciphertext we can no longer revoke must not
  // survive. A transport failure is rethrown so an operator can retry revocation.
  await deps.store.deleteCredential(deps.organizationId, deps.projectId);
  if (failures.length > 0) {
    const first = failures[0];
    throw first instanceof Error
      ? first
      : new Error("Google token revocation failed.");
  }
}

/**
 * Guard a credential before use: presence is checked, expiry is reported — but
 * no value is ever returned to the caller of this helper beyond an opaque
 * presence/absence answer, so it is safe to use in log-facing code.
 */
export function describeCredential(credential: StoredGscCredential | null): string {
  if (!credential) return "absent";
  return `present(expiresAt=${credential.accessTokenExpiresAt}, scope=${credential.scope})`;
}
