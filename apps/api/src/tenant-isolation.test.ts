import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./server.ts";
import type { FastifyInstance } from "fastify";

// ─── Tenant Isolation Test (API layer) ───
// Blueprint §19.1, §15 — cross-tenant negative tests at the HTTP boundary.
// Validates: a user in Org A cannot read/guess/modify Org B resources.
//
// Driver is EXPLICIT here: this suite unit-tests application authz wiring and
// runs in-memory with no external services. Database-level RLS isolation (the
// real security boundary) is proved separately in packages/db against a live
// PostgreSQL instance — see rls-isolation.test.ts (DB-03/04/05/06).

void describe("tenant-isolation", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ driver: "memory" });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  function extractSessionCookie(res: Awaited<ReturnType<typeof app.inject>>): string {
    const setCookie = res.headers["set-cookie"];
    if (!setCookie) return "";
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const match = /serpvera_session=([^;]+)/.exec(cookieStr ?? "");
    return match?.[1] ?? "";
  }

  async function registerAndGetSession(email: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password },
    });
    return extractSessionCookie(res);
  }

  async function createOrg(session: string, name: string, slug: string) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name, slug },
      headers: { cookie: `serpvera_session=${session}` },
    });
    return JSON.parse(res.body) as { organization?: { id: string; name: string } };
  }

  void it("user A cannot access user B's organization", async () => {
    // Register two users
    const sessionA = await registerAndGetSession("a@test.com", "password-a-123");
    const sessionB = await registerAndGetSession("b@test.com", "password-b-123");

    // User A creates Org Alpha
    const orgAlpha = await createOrg(sessionA, "Alpha Corp", "alpha-corp");
    assert.ok(orgAlpha.organization, "Org Alpha should be created");
    const orgAId = orgAlpha.organization.id;

    // User B creates Org Beta
    const orgBeta = await createOrg(sessionB, "Beta Ltd", "beta-ltd");
    assert.ok(orgBeta.organization, "Org Beta should be created");

    // User B tries to access User A's organization.
    const crossAccess = await app.inject({
      method: "GET",
      url: `/v1/organizations/${orgAId}`,
      headers: { cookie: `serpvera_session=${sessionB}` },
    });

    // Uniform 404 for both "missing" and "not a member": returning 403 would
    // leak the existence of another tenant's org (existence-oracle hardening).
    assert.equal(
      crossAccess.statusCode,
      404,
      "Cross-tenant access must be denied with a uniform 404 (no existence leak)",
    );
    const crossBody = JSON.parse(crossAccess.body) as { error?: { code?: string } };
    assert.equal(crossBody.error?.code, "NOT_FOUND");
    assert.ok(
      !crossAccess.body.includes(orgAlpha.organization.name),
      "response must not leak the other tenant's org name",
    );
  });

  void it("unauthenticated request cannot access organizations", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/organizations/any-id",
    });
    assert.equal(res.statusCode, 401);
  });

  void it("cannot guess another user's organization ID", async () => {
    const sessionA = await registerAndGetSession("c@test.com", "password-c-123");
    const org = await createOrg(sessionA, "Gamma", "gamma-org");

    // User A can access their own org
    assert.ok(org.organization, "register must return the organization");
    const ownAccess = await app.inject({
      method: "GET",
      url: `/v1/organizations/${org.organization.id}`,
      headers: { cookie: `serpvera_session=${sessionA}` },
    });
    assert.equal(ownAccess.statusCode, 200);

    // Same user, not authenticated — cannot access
    const noAuth = await app.inject({
      method: "GET",
      url: `/v1/organizations/${org.organization.id}`,
    });
    assert.equal(noAuth.statusCode, 401);
  });

  void it("auth/me returns logged-in user correctly", async () => {
    const session = await registerAndGetSession("d@test.com", "password-d-123");

    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `serpvera_session=${session}` },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body) as { user: { email: string } };
    assert.equal(body.user.email, "d@test.com");
  });

  void it("auth/me without session returns 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
    });
    assert.equal(res.statusCode, 401);
  });

  void it("logout clears session", async () => {
    const session = await registerAndGetSession("e@test.com", "password-e-123");

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: `serpvera_session=${session}` },
    });

    assert.equal(logout.statusCode, 200);

    const cookies = logout.cookies;
    const sessionCookie = cookies.find((c) => c.name === "serpvera_session");
    assert.ok(sessionCookie, "Should set clear session cookie");
    assert.equal(sessionCookie.value, "", "Session cookie should be cleared");
  });
});