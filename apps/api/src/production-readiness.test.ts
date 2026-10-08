import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { loadConfig } from "@serpvera/config";
import { assertDatabaseReadinessOverrideAllowed, buildApp } from "./server.ts";
import { assertStoreDriverAllowed, createStores, resolveStoreDriver } from "./stores/index.ts";
import { isReadinessReady } from "./stores/readiness.ts";
import {
  REQUIRED_LATEST_MIGRATION,
  REQUIRED_PATCH_STATUSES,
  inspectDatabaseReadiness,
  hasCompletePatchLifecycleConstraint,
  migrationReadinessFromCatalog,
  verifiedSchemaMarkers,
} from "./stores/db.ts";

const originalEnv = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const [key, value] of originalEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  originalEnv.clear();
}

void describe("production configuration and store selection", () => {
  after(() => {
    restoreEnv();
  });

  void it("rejects an unknown NODE_ENV instead of treating it as development", () => {
    setEnv({ NODE_ENV: "prod", AUTH_SECRET: "a-test-secret-long-enough" });

    assert.throws(() => {
      loadConfig();
    }, /NODE_ENV must be one of/);
  });

  void it("rejects unknown store drivers and memory storage in production", () => {
    setEnv({ NODE_ENV: "production", STORE_DRIVER: "memory" });
    assert.throws(() => {
      resolveStoreDriver();
    }, /memory store is not allowed in production/i);

    setEnv({ NODE_ENV: "test", STORE_DRIVER: "redis" });
    assert.throws(() => {
      resolveStoreDriver();
    }, /STORE_DRIVER must be postgres or memory/i);

    setEnv({ NODE_ENV: "prod", STORE_DRIVER: "postgres" });
    assert.throws(() => {
      resolveStoreDriver();
    }, /NODE_ENV must be one of/);
  });

  void it("rejects an explicitly supplied memory store in production", () => {
    assert.throws(() => {
      assertStoreDriverAllowed("memory", "production");
    }, /memory store is not allowed in production/i);
    assert.throws(() => {
      assertStoreDriverAllowed("memory", "prod");
    }, /NODE_ENV must be one of/);
    assert.doesNotThrow(() => {
      assertStoreDriverAllowed("memory", "test");
    });
    setEnv({ NODE_ENV: "production" });
    assert.throws(() => {
      createStores({ driver: "memory" });
    }, /memory store is not allowed in production/i);
  });

  void it("rejects database readiness test overrides in production", () => {
    assert.throws(() => {
      assertDatabaseReadinessOverrideAllowed("production", true);
    }, /readiness overrides are disabled in production/i);
    assert.doesNotThrow(() => {
      assertDatabaseReadinessOverrideAllowed("test", true);
    });
  });

  void it("rejects the readiness override through production buildApp configuration", () => {
    const source = `
      const { buildApp } = await import(${JSON.stringify(new URL("./server.ts", import.meta.url).href)});
      let app;
      try {
        app = await buildApp({
          driver: "postgres",
          databaseReadiness: async () => { throw new Error("must not run"); }
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Database readiness overrides are disabled in production.") {
          throw error;
        }
      }
      if (app) {
        await app.close();
        process.exitCode = 1;
      }
    `;
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
          REDIS_URL: "redis://127.0.0.1:1",
          AUTH_SECRET: "production-test-secret-long-enough-for-validation",
        },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
});

void describe("readiness state", () => {
  void it("only reports ready when config, database, and required schema checks are ready", () => {
    assert.equal(
      isReadinessReady({
        coreConfiguration: "valid",
        store: "postgres",
        database: "ready",
        migrationState: "ready",
        latestMigration: REQUIRED_LATEST_MIGRATION,
        requiredMigration: REQUIRED_LATEST_MIGRATION,
        requiredSchemaChecks: "ready",
        verifiedSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
        requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
      }),
      true,
    );
    assert.equal(
      isReadinessReady({
        coreConfiguration: "valid",
        store: "postgres",
        database: "ready",
        migrationState: "ready",
        latestMigration: REQUIRED_LATEST_MIGRATION,
        requiredMigration: REQUIRED_LATEST_MIGRATION,
        requiredSchemaChecks: "pending",
        verifiedSchemaMarkers: ["proven_patch_lifecycle"],
        requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
      }),
      false,
    );
    assert.equal(
      isReadinessReady({
        coreConfiguration: "invalid",
        store: "postgres",
        database: "ready",
        migrationState: "ready",
        latestMigration: REQUIRED_LATEST_MIGRATION,
        requiredMigration: REQUIRED_LATEST_MIGRATION,
        requiredSchemaChecks: "ready",
        verifiedSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
        requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
      }),
      false,
    );
    assert.equal(
      isReadinessReady({
        coreConfiguration: "valid",
        store: "postgres",
        database: "unavailable",
        migrationState: "not_checked",
        latestMigration: null,
        requiredMigration: REQUIRED_LATEST_MIGRATION,
        requiredSchemaChecks: "not_checked",
        verifiedSchemaMarkers: [],
        requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
      }),
      false,
    );
  });

  void it("verifies both patch lifecycle and tenant-safe finding evidence schema markers", () => {
    const catalog = {
      patchLifecycle: true,
      evidenceTableExists: true,
      evidenceOrganizationId: true,
      evidenceOrganizationIdNotNull: true,
      evidenceRlsEnabled: true,
      evidenceRlsForced: true,
      evidenceFindingTenantForeignKey: true,
      evidenceItemTenantForeignKey: true,
      evidenceTenantPolicy: true,
    };
    assert.deepEqual(verifiedSchemaMarkers(catalog), [
      "proven_patch_lifecycle",
      "tenant_safe_finding_evidence",
    ]);
    assert.deepEqual(verifiedSchemaMarkers({ ...catalog, evidenceRlsForced: false }), [
      "proven_patch_lifecycle",
    ]);
    assert.deepEqual(verifiedSchemaMarkers({ ...catalog, evidenceOrganizationIdNotNull: false }), [
      "proven_patch_lifecycle",
    ]);
    assert.deepEqual(verifiedSchemaMarkers({ ...catalog, patchLifecycle: false }), [
      "tenant_safe_finding_evidence",
    ]);
  });

  void it("requires every patch status from migration 0014", () => {
    const statuses = [
      "detected",
      "proposed",
      "previewed",
      "approved",
      "deploying",
      "deployed",
      "deployed_manually",
      "live_verified",
      "google_observed",
      "measuring",
      "measured",
      "rolled_back",
      "superseded",
      "drifted",
      "failed",
      "rejected",
    ];
    assert.deepEqual(REQUIRED_PATCH_STATUSES, statuses);
    const definition = `CHECK (status IN (${statuses.map((status) => `'${status}'`).join(", ")}))`;
    assert.equal(hasCompletePatchLifecycleConstraint(definition), true);
    for (const missing of statuses) {
      const incomplete = statuses.filter((status) => status !== missing);
      const incompleteDefinition = `CHECK (status IN (${incomplete
        .map((status) => `'${status}'`)
        .join(", ")}))`;
      assert.equal(
        hasCompletePatchLifecycleConstraint(incompleteDefinition),
        false,
        `missing ${missing} must leave patch lifecycle readiness pending`,
      );
    }
    assert.equal(
      hasCompletePatchLifecycleConstraint("CHECK (status IN ('deployed_manually'))"),
      false,
      "deployed_manually must not be mistaken for deployed",
    );
  });

  void it("requires recorded migrations through the latest known migration", () => {
    const migrationState = {
      patchLifecycleApplied: true,
      findingEvidenceRlsApplied: true,
      readinessViewMigrationApplied: true,
      projectCreateIdempotencyApplied: true,
      currentReadinessViewApplied: true,
      gscPropertyScopingApplied: true,
      latestVersion: REQUIRED_LATEST_MIGRATION,
    };
    assert.deepEqual(migrationReadinessFromCatalog(migrationState), {
      migrationState: "ready",
      latestMigration: REQUIRED_LATEST_MIGRATION,
      requiredMigration: REQUIRED_LATEST_MIGRATION,
    });
    assert.equal(
      migrationReadinessFromCatalog({ ...migrationState, findingEvidenceRlsApplied: false })
        .migrationState,
      "pending",
    );
    assert.equal(
      migrationReadinessFromCatalog({ ...migrationState, readinessViewMigrationApplied: false })
        .migrationState,
      "pending",
    );
    assert.equal(
      migrationReadinessFromCatalog({ ...migrationState, projectCreateIdempotencyApplied: false })
        .migrationState,
      "pending",
    );
    assert.equal(
      migrationReadinessFromCatalog({ ...migrationState, currentReadinessViewApplied: false })
        .migrationState,
      "pending",
    );
    assert.equal(
      migrationReadinessFromCatalog({ ...migrationState, gscPropertyScopingApplied: false })
        .migrationState,
      "pending",
    );
    assert.equal(
      migrationReadinessFromCatalog({
        ...migrationState,
        latestVersion: "0015_finding_evidence_tenant_rls",
      }).migrationState,
      "pending",
    );
  });

  void it("reports pending when PostgreSQL is reachable but exactly one required marker is missing", async () => {
    const catalog = {
      patchLifecycle: true,
      evidenceTableExists: true,
      evidenceOrganizationId: true,
      evidenceOrganizationIdNotNull: true,
      evidenceRlsEnabled: true,
      evidenceRlsForced: false,
      evidenceFindingTenantForeignKey: true,
      evidenceItemTenantForeignKey: true,
      evidenceTenantPolicy: true,
    };
    const readiness = await inspectDatabaseReadiness({
      healthCheck: () => Promise.resolve(true),
      readSchemaCatalog: () => Promise.resolve(catalog),
      readMigrationCatalog: () =>
        Promise.resolve({
          patchLifecycleApplied: true,
          findingEvidenceRlsApplied: true,
          readinessViewMigrationApplied: true,
          projectCreateIdempotencyApplied: true,
          currentReadinessViewApplied: true,
          gscPropertyScopingApplied: true,
          latestVersion: REQUIRED_LATEST_MIGRATION,
        }),
    });

    assert.deepEqual(readiness, {
      database: "ready",
      migrationState: "ready",
      latestMigration: REQUIRED_LATEST_MIGRATION,
      requiredMigration: REQUIRED_LATEST_MIGRATION,
      requiredSchemaChecks: "pending",
      verifiedSchemaMarkers: ["proven_patch_lifecycle"],
      requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
    });
    assert.equal(
      isReadinessReady({ coreConfiguration: "valid", store: "postgres", ...readiness }),
      false,
    );
  });

  void it("reports catalog query failures as unavailable schema checks without throwing", async () => {
    const readiness = await inspectDatabaseReadiness({
      healthCheck: () => Promise.resolve(true),
      readSchemaCatalog: () => Promise.reject(new Error("permission denied for pg_catalog query")),
      readMigrationCatalog: () =>
        Promise.resolve({
          patchLifecycleApplied: true,
          findingEvidenceRlsApplied: true,
          readinessViewMigrationApplied: true,
          projectCreateIdempotencyApplied: true,
          currentReadinessViewApplied: true,
          gscPropertyScopingApplied: true,
          latestVersion: REQUIRED_LATEST_MIGRATION,
        }),
    });

    assert.deepEqual(readiness, {
      database: "ready",
      migrationState: "ready",
      latestMigration: REQUIRED_LATEST_MIGRATION,
      requiredMigration: REQUIRED_LATEST_MIGRATION,
      requiredSchemaChecks: "unavailable",
      verifiedSchemaMarkers: [],
      requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
    });
    assert.equal(
      isReadinessReady({ coreConfiguration: "valid", store: "postgres", ...readiness }),
      false,
    );
  });

  void it("returns 503 when PostgreSQL is reachable but one required schema marker is missing", async () => {
    const app = await buildApp({
      driver: "postgres",
      databaseReadiness: () =>
        Promise.resolve({
          database: "ready",
          migrationState: "ready",
          latestMigration: REQUIRED_LATEST_MIGRATION,
          requiredMigration: REQUIRED_LATEST_MIGRATION,
          requiredSchemaChecks: "pending",
          verifiedSchemaMarkers: ["proven_patch_lifecycle"],
          requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
        }),
    });
    await app.ready();
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(ready.statusCode, 503);
      assert.deepEqual(ready.json(), {
        status: "not_ready",
        checks: {
          coreConfiguration: "valid",
          store: "postgres",
          database: "ready",
          migrationState: "ready",
          latestMigration: REQUIRED_LATEST_MIGRATION,
          requiredMigration: REQUIRED_LATEST_MIGRATION,
          requiredSchemaChecks: "pending",
          verifiedSchemaMarkers: ["proven_patch_lifecycle"],
          requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
        },
      });
    } finally {
      await app.close();
    }
  });

  void it("keeps liveness independent and reports local memory readiness explicitly", async () => {
    const app = await buildApp({ driver: "memory" });
    await app.ready();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.json(), { status: "ok", version: "0.1.0" });

      const ready = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(ready.statusCode, 200);
      assert.deepEqual(ready.json(), {
        status: "ready",
        checks: {
          coreConfiguration: "valid",
          store: "memory",
          database: "not_required",
          migrationState: "not_required",
          latestMigration: null,
          requiredMigration: null,
          requiredSchemaChecks: "not_required",
          verifiedSchemaMarkers: [],
          requiredSchemaMarkers: [],
        },
      });
    } finally {
      await app.close();
    }
  });

  void it("returns 503 from readiness when PostgreSQL cannot be reached", async () => {
    setEnv({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
    const app = await buildApp({ driver: "postgres" });
    await app.ready();
    try {
      const ready = await app.inject({ method: "GET", url: "/ready" });
      assert.equal(ready.statusCode, 503);
      assert.deepEqual(ready.json(), {
        status: "not_ready",
        checks: {
          coreConfiguration: "valid",
          store: "postgres",
          database: "unavailable",
          migrationState: "not_checked",
          latestMigration: null,
          requiredMigration: REQUIRED_LATEST_MIGRATION,
          requiredSchemaChecks: "not_checked",
          verifiedSchemaMarkers: [],
          requiredSchemaMarkers: ["proven_patch_lifecycle", "tenant_safe_finding_evidence"],
        },
      });
    } finally {
      await app.close();
      restoreEnv();
    }
  });
});
