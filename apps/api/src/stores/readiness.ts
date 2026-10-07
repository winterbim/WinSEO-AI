import type { StoreDriver } from "./index.ts";

export interface ReadinessChecks {
  coreConfiguration: "valid" | "invalid" | "not_checked";
  store: StoreDriver;
  database: "ready" | "unavailable" | "not_required";
  migrationState: "ready" | "pending" | "unavailable" | "not_checked" | "not_required";
  latestMigration: string | null;
  requiredMigration: string | null;
  requiredSchemaChecks: "ready" | "pending" | "unavailable" | "not_checked" | "not_required";
  verifiedSchemaMarkers: readonly string[];
  requiredSchemaMarkers: readonly string[];
}

export function isReadinessReady(checks: ReadinessChecks): boolean {
  if (checks.coreConfiguration !== "valid") return false;
  if (checks.store === "memory") {
    return (
      checks.database === "not_required" &&
      checks.migrationState === "not_required" &&
      checks.requiredSchemaChecks === "not_required"
    );
  }
  return (
    checks.database === "ready" &&
    checks.migrationState === "ready" &&
    checks.requiredSchemaChecks === "ready"
  );
}
