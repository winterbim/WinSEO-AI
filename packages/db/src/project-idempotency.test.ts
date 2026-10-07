import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  closePool,
  configurePool,
  createOrganization,
  createProject,
  createProjectWithIdempotencyKey,
  createUser,
  healthCheck,
  withAdmin,
} from "./index.ts";

const TAG = `idem${process.pid}${Date.now().toString(36)}`;
const EMAIL = `${TAG}@test.local`;
const IDEMPOTENCY_KEY = "0088501d-608e-4a48-bcea-ce206fc8045d";
let userId = "";
const organizationIds: string[] = [];

void describe("project creation idempotency (PostgreSQL)", () => {
  before(async () => {
    configurePool({
      host: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
      database: process.env.PGDATABASE ?? "serpvera_dev",
      runtimeRole: "serpvera_app",
      maxPool: 6,
    });
    assert.ok(await healthCheck());
    const user = await createUser(EMAIL, "idempotency-test-password-hash");
    userId = user.id;
    const organization = await createOrganization(user.id, `Idempotency ${TAG}`, `idem-${TAG}-a`);
    organizationIds.push(organization.id);
  });

  after(async () => {
    try {
      await withAdmin(async (client) => {
        if (organizationIds.length > 0) {
          await client.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [
            organizationIds,
          ]);
        }
        if (userId) await client.query("DELETE FROM users WHERE id = $1", [userId]);
      });
    } finally {
      await closePool();
    }
  });

  void it("replays concurrent same-payload requests and rejects payload reuse", async () => {
    const migrationReady = await withAdmin(async (client) => {
      const result = await client.query<{
        nullable_column: boolean;
        unique_partial_index: boolean;
      }>(
        `SELECT
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'projects'
                AND column_name = 'create_idempotency_key' AND is_nullable = 'YES'
           ) AS nullable_column,
           EXISTS (
             SELECT 1 FROM pg_index i
             JOIN pg_class idx ON idx.oid = i.indexrelid
             JOIN pg_namespace n ON n.oid = idx.relnamespace
              WHERE n.nspname = 'public'
                AND idx.relname = 'projects_org_create_idempotency_key_uq'
                AND i.indisunique AND i.indpred IS NOT NULL
           ) AS unique_partial_index`,
      );
      return result.rows[0];
    });
    assert.ok(migrationReady, "migration catalog query must return a row");
    assert.ok(migrationReady.nullable_column, "migration 0017 must add a nullable key column");
    assert.ok(
      migrationReady.unique_partial_index,
      "migration 0017 must add a partial unique index for runtime-safe tenant arbitration",
    );

    const organizationId = organizationIds[0];
    assert.ok(organizationId);
    const [first, concurrent] = await Promise.all([
      createProjectWithIdempotencyKey(
        organizationId,
        "Idempotent project",
        "idempotent.example.test",
        IDEMPOTENCY_KEY,
      ),
      createProjectWithIdempotencyKey(
        organizationId,
        "Idempotent project",
        "idempotent.example.test",
        IDEMPOTENCY_KEY,
      ),
    ]);
    const projectIds = [first, concurrent].flatMap((result) =>
      result.kind === "conflict" ? [] : [result.project.id],
    );
    assert.equal(projectIds.length, 2);
    assert.equal(
      projectIds[0],
      projectIds[1],
      "concurrent duplicate calls must return one project",
    );
    assert.deepEqual(
      [first.kind, concurrent.kind].sort(),
      ["created", "replayed"],
      "the unique index must arbitrate concurrent requests",
    );

    const conflict = await createProjectWithIdempotencyKey(
      organizationId,
      "Different project name",
      "idempotent.example.test",
      IDEMPOTENCY_KEY,
    );
    assert.deepEqual(conflict, { kind: "conflict" });
  });

  void it("scopes keys to the tenant and leaves unkeyed callers unchanged", async () => {
    const firstOrganizationId = organizationIds[0];
    assert.ok(firstOrganizationId);
    const secondOrganization = await createOrganization(
      userId,
      `Idempotency second ${TAG}`,
      `idem-${TAG}-b`,
    );
    organizationIds.push(secondOrganization.id);

    const otherTenant = await createProjectWithIdempotencyKey(
      secondOrganization.id,
      "Idempotent project",
      "idempotent.example.test",
      IDEMPOTENCY_KEY,
    );
    assert.equal(otherTenant.kind, "created");
    assert.equal(otherTenant.project.organization_id, secondOrganization.id);

    const legacyA = await createProject(
      firstOrganizationId,
      "Legacy project",
      "legacy.example.test",
    );
    const legacyB = await createProject(
      firstOrganizationId,
      "Legacy project",
      "legacy.example.test",
    );
    assert.notEqual(legacyA.id, legacyB.id, "unkeyed callers must continue creating new projects");
  });
});
