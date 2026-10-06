import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closePool,
  configurePool,
  createPatch,
  getPatch,
  listPatches,
  updatePatch,
  withAdmin,
  withTenant,
  type PatchEventInput,
} from "./index.ts";

const TAG = `patchrls${process.pid}`;
const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();
const findingA = randomUUID();
let projectA = "";
let patchId = "";

const firstEvent: PatchEventInput = {
  from: null,
  to: "proposed",
  actor: "system",
  at: new Date().toISOString(),
  reason: "fixture proposal created",
  contentHash: "a".repeat(64),
};

void describe("patch persistence RLS and immutable event ledger", () => {
  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 4,
    });
    await withAdmin(async (client) => {
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
      await client.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash'), ($3, $4, 'hash')`,
        [userA, `${TAG}-a@test.local`, userB, `${TAG}-b@test.local`],
      );
      await client.query(
        `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3), ($4, $5, $6)`,
        [orgA, `${TAG} A`, `${TAG}-a`, orgB, `${TAG} B`, `${TAG}-b`],
      );
      await client.query(
        `INSERT INTO memberships (organization_id, user_id, role) VALUES ($1, $2, 'OWNER'), ($3, $4, 'OWNER')`,
        [orgA, userA, orgB, userB],
      );
      await client.query(
        `INSERT INTO projects (id, organization_id, name, primary_domain) VALUES ($1, $2, 'Patch A', 'a.test')`,
        [randomUUID(), orgA],
      );
      const project = await client.query<{ id: string }>(
        `SELECT id FROM projects WHERE organization_id = $1 AND name = 'Patch A'`,
        [orgA],
      );
      projectA = project.rows[0]?.id ?? "";
      await client.query(
        `INSERT INTO findings (id, organization_id, project_id, rule_id, rule_version, title, epistemic_class, severity)
         VALUES ($1, $2, $3, 'PATCH.TEST', '1.0.0', 'Fixture finding', 'OBSERVED', 'low')`,
        [findingA, orgA, projectA],
      );
    });
    patchId = randomUUID();
    const proposal = {
      id: patchId,
      organizationId: orgA,
      projectId: projectA,
      findingId: findingA,
      status: "proposed",
      version: 1,
      contentHash: "a".repeat(64),
      events: [firstEvent],
    };
    await createPatch({
      organizationId: orgA,
      projectId: projectA,
      findingId: findingA,
      createdBy: userA,
      proposal,
      fixtureHtml: "<html>fixture</html>",
      events: [firstEvent],
    });
  });

  after(async () => {
    try {
      await withAdmin(async (client) => {
        await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
        await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
      });
    } finally {
      await closePool();
    }
  });

  void it("stores the tenant's proposal and appends versioned events with compare-and-swap", async () => {
    const initial = await getPatch(orgA, patchId);
    assert.ok(initial);
    assert.equal(initial.eventCount, 1);
    assert.equal(initial.proposal.events instanceof Array, true);
    assert.equal((initial.proposal.events as unknown[]).length, 1);

    const nextEvent: PatchEventInput = {
      from: "proposed",
      to: "previewed",
      actor: userA,
      at: new Date(Date.now() + 1_000).toISOString(),
      reason: "fresh preview generated",
      contentHash: "a".repeat(64),
    };
    const proposal = {
      ...initial.proposal,
      status: "previewed",
      version: 2,
      events: [...(initial.proposal.events as PatchEventInput[]), nextEvent],
    };
    const saved = await updatePatch({
      organizationId: orgA,
      patchId,
      expectedVersion: 1,
      previousEventCount: 1,
      proposal,
      fixtureHtml: "<html>previewed</html>",
      events: [nextEvent],
    });
    assert.equal(saved, true);
    const stale = await updatePatch({
      organizationId: orgA,
      patchId,
      expectedVersion: 1,
      previousEventCount: 1,
      proposal,
      fixtureHtml: "<html>stale</html>",
      events: [nextEvent],
    });
    assert.equal(stale, false);
    const listed = await listPatches(orgA, projectA);
    assert.equal(listed.length, 1);
    assert.equal((listed[0]?.proposal.events as unknown[]).length, 2);
  });

  void it("hides proposal and history rows from another organization", async () => {
    assert.equal(await getPatch(orgB, patchId), null);
    assert.equal((await listPatches(orgB, projectA)).length, 0);
    const eventCount = await withTenant(orgB, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM patch_events`,
      );
      return Number(result.rows[0]?.count ?? -1);
    });
    assert.equal(eventCount, 0);
  });

  void it("prevents the runtime role from rewriting append-only patch history", async () => {
    await assert.rejects(
      withTenant(orgA, (client) =>
        client.query(`UPDATE patch_events SET event_json = '{}'::jsonb WHERE patch_id = $1`, [
          patchId,
        ]),
      ),
      /permission denied/i,
    );
    await assert.rejects(
      withAdmin((client) =>
        client.query(`UPDATE patch_events SET event_json = '{}'::jsonb WHERE patch_id = $1`, [
          patchId,
        ]),
      ),
      /append-only/i,
    );
  });
});
