// ─── Server-side session revocation test (P-GAP-05) ───
//
// Proves the production claim: the session lives in PostgreSQL, NOT in the
// cookie. Logout must invalidate the presented token server-side — a replayed
// copy of the same cookie is rejected immediately. Also proves rotation on
// privilege change and server-side expiry.
//
// Runs against real PostgreSQL via the production store (driver: postgres).
// No mocks. Verification of row state uses withAdmin() (bypass-capable control).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import type { Response } from "light-my-request";
import { buildApp } from "./server.ts";
import { withAdmin } from "@serpvera/db";

const TAG = `sess${process.pid}${(Date.now() % 100_000).toString(36)}`;
const PW = "revocation-pw-123";

function sessionOf(res: Response): string {
  const sc = res.headers["set-cookie"];
  const raw = typeof sc === "string" ? sc : Array.isArray(sc) ? sc[0] : undefined;
  const m = /serpvera_session=([^;]+)/.exec(raw ?? "");
  return m?.[1] ?? "";
}

async function me(app: FastifyInstance, cookie: string): Promise<number> {
  const res = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: { cookie: `serpvera_session=${cookie}` },
  });
  return res.statusCode;
}

void describe("server-side session revocation (real PostgreSQL)", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ driver: "postgres" });
    await app.ready();
  });

  after(async () => {
    await app.close();
    // Session rows cascade from users; projects cascade from the org.
    // Remove ALL fixtures this suite created (users, sessions, org, projects).
    await withAdmin(async (c) => {
      await c.query(`DELETE FROM users WHERE email LIKE $1`, [`sess%${TAG}@test.local`]);
      await c.query(`DELETE FROM organizations WHERE name = $1`, [`Revocation Org ${TAG}`]);
    });
  });

  async function register(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email, password: PW },
    });
    assert.equal(res.statusCode, 201, `register failed: ${res.body}`);
    return sessionOf(res);
  }

  void it("logout REVOKES the session server-side — the same cookie is rejected afterwards", async () => {
    const email = `sesslogout_${TAG}@test.local`.replace(/_/g, "");
    const cookie = await register(email);

    assert.equal(await me(app, cookie), 200, "fresh session must authenticate");

    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: `serpvera_session=${cookie}` },
    });
    assert.equal(out.statusCode, 200);

    // THE claim: replaying the pre-logout cookie must fail NOW — not at Max-Age.
    assert.equal(await me(app, cookie), 401, "revoked cookie must be rejected on replay");

    // Row-level proof: revoked_at is set in PostgreSQL (not just cookie cleared).
    const rows = await withAdmin(async (c) => {
      const r = await c.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM sessions WHERE token_hash = encode(digest($1, 'sha256'), 'hex')`,
        [cookie],
      );
      return r.rows;
    });
    assert.equal(rows.length, 1, "session row must exist");
    const [sessionRow] = rows;
    assert.ok(sessionRow, "session row must exist");
    assert.ok(sessionRow.revoked_at, "revoked_at must be set server-side");
  });

  void it("logout-all revokes EVERY session of the user", async () => {
    const email = `sessall${TAG}@test.local`;
    const c1 = await register(email);
    const login2 = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email, password: PW },
    });
    assert.equal(login2.statusCode, 200);
    const c2 = sessionOf(login2);
    assert.notEqual(c1, c2, "each login must issue a distinct token");

    assert.equal(await me(app, c1), 200);
    assert.equal(await me(app, c2), 200);

    const out = await app.inject({
      method: "POST",
      url: "/v1/auth/logout-all",
      headers: { cookie: `serpvera_session=${c1}` },
    });
    assert.equal(out.statusCode, 200);
    const body = JSON.parse(out.body) as { revoked: number };
    assert.ok(body.revoked >= 2, `both sessions must be revoked, got ${body.revoked}`);

    assert.equal(await me(app, c1), 401, "session 1 dead after logout-all");
    assert.equal(await me(app, c2), 401, "session 2 dead after logout-all");
  });

  void it("select-organization ROTATES the token — old cookie dies, new one carries the tenant", async () => {
    const email = `sessrot${TAG}@test.local`;
    const cookie = await register(email);

    const orgRes = await app.inject({
      method: "POST",
      url: "/v1/organizations",
      payload: { name: `Revocation Org ${TAG}` },
      headers: { cookie: `serpvera_session=${cookie}` },
    });
    assert.equal(orgRes.statusCode, 201, orgRes.body);
    const orgId = (JSON.parse(orgRes.body) as { organization: { id: string } }).organization.id;

    const sel = await app.inject({
      method: "POST",
      url: "/v1/auth/select-organization",
      payload: { organizationId: orgId },
      headers: { cookie: `serpvera_session=${cookie}` },
    });
    assert.equal(sel.statusCode, 200, sel.body);
    const rotated = sessionOf(sel);
    assert.ok(rotated, "rotation must issue a fresh token");
    assert.notEqual(rotated, cookie, "rotation must change the token");

    // Privilege change invalidates the previous token server-side.
    assert.equal(await me(app, cookie), 401, "pre-rotation cookie must be revoked");
    // The rotated cookie carries the verified tenant context.
    const fresh = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `serpvera_session=${rotated}` },
    });
    assert.equal(fresh.statusCode, 200);

    const proj = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: { organizationId: orgId, primaryDomain: "rot.example.com" },
      headers: { cookie: `serpvera_session=${rotated}` },
    });
    assert.equal(proj.statusCode, 201, `rotated session must have tenant context: ${proj.body}`);
  });

  void it("an EXPIRED session is rejected server-side even though the cookie is still present", async () => {
    const email = `sessexp${TAG}@test.local`;
    const cookie = await register(email);
    assert.equal(await me(app, cookie), 200);

    // Backdate expiry directly in PostgreSQL (admin control plane).
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE sessions SET expires_at = now() - interval '1 minute'
          WHERE token_hash = encode(digest($1, 'sha256'), 'hex')`,
        [cookie],
      );
    });

    assert.equal(await me(app, cookie), 401, "expired session must not authenticate");
  });
});
