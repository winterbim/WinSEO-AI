// ─── API ⇄ PostgreSQL persistence integration test ───
// P-GAP-02 section "API repository integration".
//
// Runs the production route/store path → PostgreSQL with RLS enforced under
// serpvera_app. Audit requests use a deterministic local HTML fixture.
//
// Verification queries use withAdmin() from @serpvera/db, which runs as the
// login role (peer socket = local superuser `wina`, bypass-capable). That is the
// correct control: a bypass-capable reader MUST see the rows the isolated
// runtime role cannot — otherwise the isolation assertions would be vacuous.
//
// Requires serpvera_dev migrated: node packages/db/src/migrate.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";
import { createFixtureAuditRunner } from "./audit/fixture-audit.ts";

// NOTE: must be lowercase-alphanumeric (no underscore). TAG is reused inside
// organization slugs and hostnames, both of which the API validates strictly;
// an underscore-containing tag would make those requests fail input validation
// and mask the persistence behaviour under test.
const TAG = `api${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PW_A = "persist-pw-123";
const PW_B = "persist-pw-456";

const ctx: {
  emailA: string;
  emailB: string;
  userIdA?: string;
  userIdB?: string;
  orgAId?: string;
  orgBId?: string;
  projAId?: string;
  /** Server-signed cookie carrying tenant A context (from select-organization). */
  cookieA?: string;
} = {
  emailA: `appa_${TAG}@test.local`,
  emailB: `appb_${TAG}@test.local`,
};

void describe("API persistence over real PostgreSQL (RLS enforced)", () => {
  let app: FastifyInstance;

  function sessionOf(res: Response): string {
    const sc = res.headers["set-cookie"];
    const raw = typeof sc === "string" ? sc : Array.isArray(sc) ? sc[0] : undefined;
    const m = /serpvera_session=([^;]+)/.exec(raw ?? "");
    return m?.[1] ?? "";
  }

  async function register(
    email: string,
    password: string,
  ): Promise<{ id: string; cookie: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password },
    });
    assert.equal(res.statusCode, 201, `register failed: ${res.body}`);
    return {
      id: (JSON.parse(res.body) as { user: { id: string } }).user.id,
      cookie: sessionOf(res),
    };
  }

  before(async () => {
    app = await buildApp({
      driver: "postgres",
      maxPool: 4,
      auditDomain: createFixtureAuditRunner(),
    });
    await app.ready();
  });

  after(async () => {
    // Cleanup FIRST (pool still open), then close the app (which ends the pool).
    try {
      await withAdmin(async (c) => {
        await c.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}@test.local`]);
        if (ctx.orgAId) await c.query(`DELETE FROM organizations WHERE id=$1`, [ctx.orgAId]);
        if (ctx.orgBId) await c.query(`DELETE FROM organizations WHERE id=$1`, [ctx.orgBId]);
        await c.query(`DELETE FROM public_scans WHERE domain LIKE $1`, [`%${TAG}%`]);
      });
    } catch {
      /* best-effort cleanup */
    }
    await app.close();
  });

  void it("register persists the user in PostgreSQL (hash stored, no plaintext leak)", async () => {
    const a = await register(ctx.emailA, PW_A);
    ctx.userIdA = a.id;

    const rows = await withAdmin(async (c) => {
      const r = await c.query<{ email: string; has_hash: boolean }>(
        `SELECT email, (password_hash IS NOT NULL) AS has_hash FROM users WHERE id=$1`,
        [ctx.userIdA],
      );
      return r.rows;
    });
    assert.equal(rows.length, 1, "user row must exist in PostgreSQL");
    const [userRow] = rows;
    assert.ok(userRow, "user row must exist in PostgreSQL");
    assert.equal(userRow.email, ctx.emailA);
    assert.equal(userRow.has_hash, true);
  });

  void it("duplicate register is rejected by the DB UNIQUE constraint (409 EMAIL_EXISTS)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: ctx.emailA, password: PW_A },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal((JSON.parse(res.body) as { error: { code: string } }).error.code, "EMAIL_EXISTS");
  });

  void it("a forged session cookie is rejected (opaque server-side tokens)", async () => {
    // Forge a cookie claiming tenant A ownership. Under server-side sessions
    // (P-GAP-05) the cookie IS an opaque server-issued token — a client-made
    // payload is simply an unknown token and must never authenticate.
    const forged = Buffer.from(
      JSON.stringify({
        userId: ctx.userIdA,
        email: ctx.emailA,
        organizationId: ctx.orgAId,
      }),
    ).toString("base64url");

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `serpvera_session=${forged}` },
    });
    assert.equal(me.statusCode, 401, "forged cookie must not authenticate");
  });

  void it("select-organization establishes a verified tenant context (role read from DB)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: ctx.emailA, password: PW_A },
    });
    const baseCookie = sessionOf(login);

    const orgRes = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: `Persist Org ${TAG}`, slug: `persist-${TAG}` },
      headers: { cookie: `serpvera_session=${baseCookie}` },
    });
    assert.equal(orgRes.statusCode, 201, orgRes.body);
    ctx.orgAId = (JSON.parse(orgRes.body) as { organization: { id: string } }).organization.id;

    // Membership persisted as OWNER (verified out-of-band as admin).
    const membership = await withAdmin(async (c) => {
      const r = await c.query<{ role: string; status: string }>(
        `SELECT role, status FROM memberships WHERE organization_id=$1 AND user_id=$2`,
        [ctx.orgAId, ctx.userIdA],
      );
      return r.rows[0];
    });
    assert.equal(membership?.role, "OWNER");
    assert.equal(membership.status, "active");

    const sel = await app.inject({
      method: "POST",
      url: "/v1/auth/select-organization",
      payload: { organizationId: ctx.orgAId },
      headers: { cookie: `serpvera_session=${baseCookie}` },
    });
    assert.equal(sel.statusCode, 200, sel.body);
    const tenantCookie = sessionOf(sel);
    assert.ok(tenantCookie, "select-organization must issue a tenant-scoped cookie");
    ctx.cookieA = tenantCookie;
  });

  void it("project creation + read persist under the owner tenant (RLS allows own rows)", async () => {
    assert.ok(ctx.cookieA, "tenant cookie must be issued in setup");
    const tenantCookie = ctx.cookieA;
    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        organizationId: ctx.orgAId,
        primaryDomain: `${TAG}.example.com`,
        name: "Persist Site",
      },
      headers: { cookie: `serpvera_session=${tenantCookie}` },
    });
    assert.equal(projRes.statusCode, 201, projRes.body);
    ctx.projAId = (JSON.parse(projRes.body) as { project: { id: string } }).project.id;

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/projects/${ctx.projAId}`,
      headers: { cookie: `serpvera_session=${tenantCookie}` },
    });
    assert.equal(getRes.statusCode, 200, getRes.body);

    // Row exists in PostgreSQL, owned by org A.
    const row = await withAdmin(async (c) => {
      const r = await c.query<{ organization_id: string }>(
        `SELECT organization_id FROM projects WHERE id=$1`,
        [ctx.projAId],
      );
      return r.rows[0];
    });
    assert.equal(row?.organization_id, ctx.orgAId);
  });

  void it("project read without an active organization is rejected (400, no tenant context)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: ctx.emailA, password: PW_A },
    });
    const noTenantCookie = sessionOf(login); // no organizationId
    const res = await app.inject({
      method: "GET",
      url: `/v1/projects/${ctx.projAId}`,
      headers: { cookie: `serpvera_session=${noTenantCookie}` },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(
      (JSON.parse(res.body) as { error: { code: string } }).error.code,
      "NO_ACTIVE_ORGANIZATION",
    );
  });

  void it("RLS blocks cross-tenant project + org reads through the REAL API path (uniform 404)", async () => {
    // Build tenant B.
    const b = await register(ctx.emailB, PW_B);
    ctx.userIdB = b.id;
    const orgBRes = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: `Org B ${TAG}`, slug: `orgb-${TAG}` },
      headers: { cookie: `serpvera_session=${b.cookie}` },
    });
    assert.equal(orgBRes.statusCode, 201, orgBRes.body);
    ctx.orgBId = (JSON.parse(orgBRes.body) as { organization: { id: string } }).organization.id;

    // B selects org B → tenant-scoped cookie.
    const selB = await app.inject({
      method: "POST",
      url: "/v1/auth/select-organization",
      payload: { organizationId: ctx.orgBId },
      headers: { cookie: `serpvera_session=${b.cookie}` },
    });
    assert.equal(selB.statusCode, 200, selB.body);
    const cookieB = sessionOf(selB);

    // B tries to read A's PROJECT → 404 (RLS yields zero rows; not an error leak).
    const crossProj = await app.inject({
      method: "GET",
      url: `/v1/projects/${ctx.projAId}`,
      headers: { cookie: `serpvera_session=${cookieB}` },
    });
    assert.equal(
      crossProj.statusCode,
      404,
      `expected 404, got ${crossProj.statusCode}: ${crossProj.body}`,
    );

    // B tries to read A's ORG → uniform 404 (membership gate, no existence leak).
    const crossOrg = await app.inject({
      method: "GET",
      url: `/v1/organizations/${ctx.orgAId}`,
      headers: { cookie: `serpvera_session=${cookieB}` },
    });
    assert.equal(crossOrg.statusCode, 404, `expected 404, got ${crossOrg.statusCode}`);

    // POSITIVE CONTROL: bypass-capable admin DOES see both projects (data exists),
    // proving the 404s are caused by RLS/membership, not by missing rows.
    const bothVisible = await withAdmin(async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM projects WHERE organization_id = ANY($1::uuid[])`,
        [[ctx.orgAId, ctx.orgBId]],
      );
      return r.rows.length;
    });
    assert.ok(bothVisible >= 1, "admin (bypass) must see the persisted project(s)");
    const aStillReadable = await withAdmin(async (c) => {
      const r = await c.query<{ id: string }>(`SELECT id FROM projects WHERE id=$1`, [ctx.projAId]);
      return r.rows.length;
    });
    assert.equal(aStillReadable, 1, "positive control: project A exists (RLS caused the 404)");
  });

  void it("public scan persists to PostgreSQL and is retrievable by UUID", async () => {
    const domain = `${TAG}-scan.example.invalid`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/public-scans",
      payload: { domain },
    });
    // The row must persist independently of the asynchronous audit completion.
    assert.equal(res.statusCode, 201, res.body);
    const scanId = (JSON.parse(res.body) as { scanId: string }).scanId;
    const normalizedTarget = `https://${domain}/`;

    const row = await withAdmin(async (c) => {
      const r = await c.query<{ domain: string; status: string }>(
        `SELECT domain, status FROM public_scans WHERE id=$1`,
        [scanId],
      );
      return r.rows[0];
    });
    assert.ok(row, "public_scans row must be persisted in PostgreSQL");
    assert.equal(row.domain, normalizedTarget);

    // And the API can read it back by UUID.
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/public-scans/${scanId}`,
    });
    assert.equal(getRes.statusCode, 200, getRes.body);
  });

  void it("invalid slug is rejected as 400 VALIDATION_ERROR without leaking schema internals", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: ctx.emailA, password: PW_A },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      // Underscore + uppercase violate the slug rule.
      payload: { name: "Bad Slug", slug: "BAD_slug!" },
      headers: { cookie: `serpvera_session=${sessionOf(login)}` },
    });
    assert.equal(res.statusCode, 400, res.body);
    const body = JSON.parse(res.body) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "VALIDATION_ERROR");
    // Must not echo Zod internals (regex, schema paths, issue details).
    assert.ok(!res.body.includes("invalid_format"), "must not leak Zod issue codes");
    assert.ok(!res.body.includes("regex"), "must not leak the validation regex");
    assert.ok(!res.body.includes("a-z0-9"), "must not leak the slug pattern");
  });

  void it("store error mapping depends on exact UNIQUE constraint names (regression guard)", async () => {
    // stores/db.ts maps SQLSTATE 23505 by CONSTRAINT NAME. If a migration ever
    // renames these, duplicate detection would silently degrade to a generic
    // 500. Fail loudly instead.
    const names = await withAdmin(async (c) => {
      const r = await c.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE contype='u' AND conrelid::regclass::text IN ('users','organizations')`,
      );
      return r.rows.map((x) => x.conname);
    });
    assert.ok(
      names.includes("users_email_key"),
      "users_email_key must exist (DuplicateEmailError mapping)",
    );
    assert.ok(
      names.includes("organizations_slug_key"),
      "organizations_slug_key must exist (DuplicateSlugError mapping)",
    );
  });

  void it("public scan REJECTS a private/loopback target (SSRF, pre-queue, 400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/public-scans",
      payload: { domain: "127.0.0.1" },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((JSON.parse(res.body) as { error: { code: string } }).error.code, "SSRF_BLOCKED");
    // Must NOT have created a scan row for a blocked target.
    const count = await withAdmin(async (c) => {
      const r = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public_scans WHERE domain=$1`,
        ["127.0.0.1"],
      );
      return r.rows[0]?.n;
    });
    assert.equal(count, 0, "blocked SSRF target must not persist a scan row");
  });
});
