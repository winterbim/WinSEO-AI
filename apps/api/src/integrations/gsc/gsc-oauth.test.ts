// GSC-001 / GSC-002 — OAuth security and token lifecycle, deterministically.
//
// CLAIM: state is unforgeable/single-use/expiring and tenant-bound; PKCE binds
// the code exchange; the authorize URL carries no secret; access tokens are
// refreshed transparently and persisted ONLY as envelope ciphertext; disconnect
// revokes at Google and erases local material unconditionally.
// Fixtures exercise the orchestration; live Google is gated separately
// (GSC-004/GSC-005 BLOCKED until real credentials exist).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ACCESS_TOKEN_SKEW_SECONDS,
  accessTokenNeedsRefresh,
  buildAuthorizeUrl,
  createPkcePair,
  createStateToken,
  describeCredential,
  disconnectGoogle,
  getValidAccessToken,
  hashState,
  parseStateOrganization,
} from "./oauth.ts";
import { decryptSecret, deriveGscKey, encryptSecret } from "./crypto.ts";
import { GscApiError, GOOGLE_AUTHORIZE_ENDPOINT } from "./google-transport.ts";
import { GscCredentialsRequiredError } from "./types.ts";
import { FakeGscStore, FakeGoogleTransport, invalidGrantError } from "./test-doubles.ts";

const KEY = deriveGscKey("gsc-oauth-test-master-secret-at-least-32-chars");
const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "fixture-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "fixture-client-secret";
// Real-clock anchored: expiry checks compare against Date.now() exactly as
// production does, so fixtures must stay relative to the running clock.
const NOW = Date.now();

function seedCredential(
  store: FakeGscStore,
  accessToken: string,
  refreshToken: string,
  expiresAtIso: string,
): void {
  store.credentials.set(`${ORG}:${PROJECT}`, {
    id: "cred-1",
    organizationId: ORG,
    projectId: PROJECT,
    encryptedAccessToken: encryptSecret(accessToken, KEY),
    encryptedRefreshToken: encryptSecret(refreshToken, KEY),
    accessTokenExpiresAt: expiresAtIso,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    googleSubject: "google-sub-1",
  });
}

void describe("GSC-001 OAuth security", () => {
  void it("binds state to its tenant and detects any tampering via the stored hash", () => {
    const { state, stateHash, organizationId } = createStateToken(ORG);
    assert.equal(organizationId, ORG);
    assert.equal(stateHash, hashState(state));
    assert.match(stateHash, /^[0-9a-f]{64}$/, "state is stored as SHA-256, never raw");

    // Tampering with either component changes the hash → the lookup misses.
    const [tenantPart, nonce] = state.split(".") as [string, string];
    const tamperedTenant = `${Buffer.from(ORG.replace(/1/g, "2"), "utf8").toString("base64url")}.${nonce}`;
    const tamperedNonce = `${tenantPart}.${nonce.slice(0, -1)}x`;
    assert.notEqual(hashState(tamperedTenant), stateHash);
    assert.notEqual(hashState(tamperedNonce), stateHash);
  });

  void it("recovers the tenant scope only from well-formed states", () => {
    const { state } = createStateToken(ORG);
    assert.equal(parseStateOrganization(state), ORG);
    assert.equal(parseStateOrganization(""), null);
    assert.equal(parseStateOrganization("no-separator"), null);
    assert.equal(parseStateOrganization(".leading-separator"), null);
    assert.equal(parseStateOrganization("%%%not-base64%%%.nonce"), null);
    assert.equal(
      parseStateOrganization(`${Buffer.from("not-a-uuid").toString("base64url")}.abc`),
      null,
      "non-UUID tenant scopes are rejected before any DB transaction",
    );
  });

  void it("enforces single-use and expiry when a state is claimed", async () => {
    const store = new FakeGscStore();
    const issued = createStateToken(ORG);
    await store.createOauthState({
      organizationId: ORG,
      projectId: PROJECT,
      stateHash: issued.stateHash,
      codeVerifier: "verifier-1",
      expiresAt: new Date(NOW + 600_000).toISOString(),
    });

    const first = await store.consumeOauthState(ORG, issued.stateHash);
    assert.deepEqual(first, { projectId: PROJECT, codeVerifier: "verifier-1" });
    const replay = await store.consumeOauthState(ORG, issued.stateHash);
    assert.equal(replay, null, "a replayed callback finds no row");
  });

  void it("refuses expired states and foreign-tenant claims identically to unknown states", async () => {
    const store = new FakeGscStore();
    const expired = createStateToken(ORG);
    await store.createOauthState({
      organizationId: ORG,
      projectId: PROJECT,
      stateHash: expired.stateHash,
      codeVerifier: "verifier-x",
      expiresAt: new Date(NOW - 1).toISOString(),
    });
    assert.equal(await store.consumeOauthState(ORG, expired.stateHash), null);

    const foreign = createStateToken(ORG);
    await store.createOauthState({
      organizationId: ORG,
      projectId: PROJECT,
      stateHash: foreign.stateHash,
      codeVerifier: "verifier-y",
      expiresAt: new Date(NOW + 600_000).toISOString(),
    });
    assert.equal(
      await store.consumeOauthState("99999999-9999-4999-8999-999999999999", foreign.stateHash),
      null,
      "a cross-tenant claim is indistinguishable from an unknown state",
    );
  });

  void it("derives the PKCE challenge per RFC 7636 (S256) and keeps the verifier server-side", () => {
    const { codeVerifier, codeChallenge } = createPkcePair();
    assert.match(codeVerifier, /^[A-Za-z0-9_-]{64}$/, "48 random bytes, base64url");
    assert.notEqual(codeVerifier, codeChallenge);
    assert.equal(
      codeChallenge,
      createHash("sha256").update(codeVerifier, "utf8").digest("base64url"),
      "challenge must be base64url(SHA-256(verifier))",
    );
  });

  void it("builds a consent URL with PKCE + offline access and NO secret material", () => {
    const { state } = createStateToken(ORG);
    const { codeChallenge } = createPkcePair();
    const url = new URL(
      buildAuthorizeUrl({
        clientId: CLIENT_ID,
        redirectUri: "http://localhost:3000/api/integrations/gsc/callback",
        state,
        codeChallenge,
      }),
    );
    assert.equal(url.origin + url.pathname, GOOGLE_AUTHORIZE_ENDPOINT);
    assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), state);
    assert.equal(url.searchParams.get("code_challenge"), codeChallenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.ok(
      url.searchParams.get("scope")?.includes("webmasters.readonly"),
      "least-privilege read-only scope",
    );
    assert.ok(!url.toString().includes(CLIENT_SECRET), "the consent URL must never carry a secret");
    assert.equal(url.searchParams.get("client_secret"), null);
  });
});

void describe("GSC-002 token lifecycle", () => {
  void it("returns a fresh token without a refresh round trip", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport();
    seedCredential(
      store,
      "ya29.still-fresh",
      "1//refresh-A",
      new Date(NOW + 3_600_000).toISOString(),
    );

    const token = await getValidAccessToken({
      store,
      transport,
      key: KEY,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      organizationId: ORG,
      projectId: PROJECT,
      now: NOW,
    });
    assert.equal(token, "ya29.still-fresh", "ciphertext is decrypted only in memory");
    assert.equal(transport.refreshTokensUsed.length, 0);
  });

  void it("refreshes an expired token and persists ONLY the rotated ciphertext", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport({
      refreshTokenResponse: { accessToken: "ya29.rotated", refreshToken: "1//refresh-B" },
    });
    seedCredential(store, "ya29.stale", "1//refresh-A", new Date(NOW - 1_000).toISOString());

    const token = await getValidAccessToken({
      store,
      transport,
      key: KEY,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      organizationId: ORG,
      projectId: PROJECT,
      now: NOW,
    });
    assert.equal(token, "ya29.rotated");
    assert.deepEqual(transport.refreshTokensUsed, ["1//refresh-A"]);

    const stored = await store.getCredential(ORG, PROJECT);
    assert.ok(stored);
    assert.ok(!stored.encryptedAccessToken.includes("ya29.rotated"), "at rest: ciphertext only");
    assert.ok(!stored.encryptedRefreshToken.includes("refresh-B"), "at rest: ciphertext only");
    assert.equal(decryptSecret(stored.encryptedAccessToken, KEY), "ya29.rotated");
    assert.equal(decryptSecret(stored.encryptedRefreshToken, KEY), "1//refresh-B");
    assert.equal(
      Date.parse(stored.accessTokenExpiresAt),
      NOW + 3599 * 1000,
      "expiry is recomputed from the refresh response",
    );
  });

  void it("keeps the old refresh token when Google does not rotate it", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport();
    seedCredential(store, "ya29.stale", "1//refresh-A", new Date(NOW - 1_000).toISOString());

    await getValidAccessToken({
      store,
      transport,
      key: KEY,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      organizationId: ORG,
      projectId: PROJECT,
      now: NOW,
    });
    const stored = await store.getCredential(ORG, PROJECT);
    assert.ok(stored);
    assert.equal(decryptSecret(stored.encryptedRefreshToken, KEY), "1//refresh-A");
  });

  void it("refreshes inside the expiry skew so an in-flight call cannot race expiry", () => {
    const expiresAt = new Date(NOW + ACCESS_TOKEN_SKEW_SECONDS * 1000).toISOString();
    assert.equal(accessTokenNeedsRefresh(expiresAt, NOW), true, "within the skew window");
    assert.equal(
      accessTokenNeedsRefresh(
        new Date(NOW + (ACCESS_TOKEN_SKEW_SECONDS + 5) * 1000).toISOString(),
        NOW,
      ),
      false,
    );
    assert.equal(accessTokenNeedsRefresh("not-a-date", NOW), true, "malformed expiry fails closed");
  });

  void it("treats a revoked refresh token (invalid_grant) exactly like no grant", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport({ refreshErrors: [invalidGrantError()] });
    seedCredential(store, "ya29.stale", "1//revoked", new Date(NOW - 1_000).toISOString());

    // BLOCKED, explicitly: a dead grant is not a transient failure to retry,
    // and never a licence to fabricate rows.
    await assert.rejects(
      getValidAccessToken({
        store,
        transport,
        key: KEY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        organizationId: ORG,
        projectId: PROJECT,
        now: NOW,
      }),
      GscCredentialsRequiredError,
    );
  });

  void it("reports missing credentials explicitly (BLOCKED path, never fabricated)", async () => {
    const store = new FakeGscStore();
    await assert.rejects(
      getValidAccessToken({
        store,
        transport: new FakeGoogleTransport(),
        key: KEY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        organizationId: ORG,
        projectId: PROJECT,
        now: NOW,
      }),
      GscCredentialsRequiredError,
    );
  });

  void it("disconnect revokes BOTH tokens at Google and erases local material", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport();
    seedCredential(store, "ya29.live", "1//refresh-A", new Date(NOW + 3_600_000).toISOString());

    await disconnectGoogle({
      store,
      transport,
      key: KEY,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      organizationId: ORG,
      projectId: PROJECT,
    });
    assert.deepEqual(
      transport.revokedTokens.sort(),
      ["1//refresh-A", "ya29.live"].sort(),
      "both token kinds are revoked — Google accepts either",
    );
    assert.equal(await store.getCredential(ORG, PROJECT), null);
  });

  void it("erases local material even when Google revocation fails, and surfaces the failure", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport({
      revokeErrors: [
        new GscApiError("NETWORK", "revoke endpoint unreachable", { retryable: true }),
      ],
    });
    seedCredential(store, "ya29.live", "1//refresh-A", new Date(NOW + 3_600_000).toISOString());

    await assert.rejects(
      disconnectGoogle({
        store,
        transport,
        key: KEY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        organizationId: ORG,
        projectId: PROJECT,
      }),
      (err: unknown) => err instanceof GscApiError && err.code === "NETWORK",
    );
    assert.deepEqual(
      transport.revokedTokens.sort(),
      ["1//refresh-A", "ya29.live"].sort(),
      "ONE failed revocation must not skip the other — both are attempted",
    );
    assert.equal(
      await store.getCredential(ORG, PROJECT),
      null,
      "unrevocable ciphertext must not survive locally",
    );
  });

  void it("erases local material when EVERY revocation fails (the unreachable-endpoint case)", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport({
      revokeErrors: [
        new GscApiError("NETWORK", "revoke endpoint unreachable", { retryable: true }),
        new GscApiError("NETWORK", "revoke endpoint unreachable", { retryable: true }),
      ],
    });
    seedCredential(store, "ya29.live", "1//refresh-A", new Date(NOW + 3_600_000).toISOString());

    await assert.rejects(
      disconnectGoogle({
        store,
        transport,
        key: KEY,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        organizationId: ORG,
        projectId: PROJECT,
      }),
      (err: unknown) => err instanceof GscApiError && err.code === "NETWORK",
    );
    assert.deepEqual(
      transport.revokedTokens.sort(),
      ["1//refresh-A", "ya29.live"].sort(),
      "both revocations are attempted even when both fail",
    );
    assert.equal(
      await store.getCredential(ORG, PROJECT),
      null,
      "erasure is unconditional even when nothing could be revoked",
    );
  });

  void it("treats disconnect without a credential as a no-op", async () => {
    const store = new FakeGscStore();
    const transport = new FakeGoogleTransport();
    await disconnectGoogle({
      store,
      transport,
      key: KEY,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      organizationId: ORG,
      projectId: PROJECT,
    });
    assert.deepEqual(transport.revokedTokens, []);
  });

  void it("describes credentials for logs without ever revealing token material", async () => {
    const store = new FakeGscStore();
    seedCredential(
      store,
      "ya29.super-secret",
      "1//super-secret-refresh",
      new Date(NOW + 1000).toISOString(),
    );
    const stored = await store.getCredential(ORG, PROJECT);
    const described = describeCredential(stored);
    assert.ok(!described.includes("ya29.super-secret"));
    assert.ok(!described.includes("super-secret-refresh"));
    assert.ok(!described.includes(stored?.encryptedAccessToken ?? "x"));
    assert.match(described, /^(absent|present\(expiresAt=.+\))$/);
    assert.equal(describeCredential(null), "absent");
  });
});
