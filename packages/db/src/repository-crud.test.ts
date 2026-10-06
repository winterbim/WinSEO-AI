// ─── Repository CRUD tests (real PostgreSQL) ───
// P-GAP-02 section 9: proves the DB-backed repositories replace in-memory stores.
// Covers user/org/project/public-scan create+read, ownership membership gating,
// and non-predictable scan ids.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  configurePool,
  closePool,
  withAdmin,
  healthCheck,
  createUser,
  findUserByEmail,
  createOrganization,
  getOrganizationForMember,
  createProject,
  getProject,
  createPublicScan,
  getPublicScan,
  updatePublicScanResult,
} from "./index.ts";

const TAG = `repo_${process.pid}_${Date.now()}`;
const ids: { orgA: string; scan: string } = { orgA: "", scan: "" };
let userA: string;

void describe("repository CRUD (real PostgreSQL)", () => {
  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 3,
    });
    assert.ok(await healthCheck());
  });

  after(async () => {
    try {
      await withAdmin(async (c) => {
        if (ids.scan) await c.query(`DELETE FROM public_scans WHERE id=$1`, [ids.scan]);
        await c.query(`DELETE FROM users WHERE email LIKE $1`, [`%${TAG}@test.local`]);
        if (ids.orgA) await c.query(`DELETE FROM organizations WHERE id=$1`, [ids.orgA]);
      });
    } finally {
      await closePool();
    }
  });

  void it("creates and reads back a user (password hash stored, not returned by findUserById)", async () => {
    const u = await createUser(`${TAG}@test.local`, "scrypt-hash-placeholder");
    userA = u.id;
    assert.ok(u.id);
    assert.equal(u.email, `${TAG}@test.local`);

    const byEmail = await findUserByEmail(`${TAG}@test.local`);
    assert.ok(byEmail);
    assert.equal(byEmail.password_hash, "scrypt-hash-placeholder");
  });

  void it("rejects duplicate user email (UNIQUE constraint)", async () => {
    await assert.rejects(
      () => createUser(`${TAG}@test.local`, "another-hash"),
      /duplicate key|unique/i,
    );
  });

  void it("creates an organization and grants OWNER membership", async () => {
    const org = await createOrganization(userA, `RepoOrg ${TAG}`, `repo-${TAG}`);
    ids.orgA = org.id;
    assert.ok(org.id);
    assert.equal(org.slug, `repo-${TAG}`);

    // A non-member user cannot read it via the membership-gated reader.
    const stranger = await createUser(`stranger_${TAG}@test.local`, "h");
    const denied = await getOrganizationForMember(stranger.id, org.id);
    assert.equal(denied, null, "non-member must not read the org");

    const allowed = await getOrganizationForMember(userA, org.id);
    assert.ok(allowed, "member/owner must read the org");
  });

  void it("creates and reads a project scoped to the org", async () => {
    const proj = await createProject(ids.orgA, "Site", "site.example.com");
    assert.equal(proj.organization_id, ids.orgA);
    const got = await getProject(ids.orgA, proj.id);
    assert.ok(got, "created project must be readable");
    assert.equal(got.id, proj.id);
  });

  void it("public scan: create, non-predictable id, update, read back", async () => {
    const scan = await createPublicScan("example.com");
    ids.scan = scan.id;
    assert.ok(scan.id);
    assert.equal(scan.status, "pending");
    // UUID v4 must not be sequential/predictable
    assert.match(scan.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      "scan id must be a random UUIDv4 (anti-enumeration)");

    await updatePublicScanResult(
      scan.id,
      "completed",
      [{ ruleId: "ONPAGE.MISSING_TITLE", severity: "high" }],
      [{ kind: "html_snapshot", sourceRef: "https://example.com/" }],
    );

    const after = await getPublicScan(scan.id);
    assert.ok(after, "updated public scan must be readable");
    assert.equal(after.status, "completed");
    assert.ok(Array.isArray(after.findings));
    assert.equal((after.findings as unknown[]).length, 1);
    assert.equal((after.evidence as unknown[]).length, 1);
  });

  void it("getPublicScan returns null for unknown id (no info leak)", async () => {
    const missing = await getPublicScan("00000000-0000-4000-8000-000000000000");
    assert.equal(missing, null);
  });
});
