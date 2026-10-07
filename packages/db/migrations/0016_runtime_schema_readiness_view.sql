-- Give the runtime role a read-only, checksum-free view of migration state.
-- The application receives required migration flags and the latest version
-- only; it cannot inspect schema_migrations checksums or other ledger columns.

BEGIN;

CREATE OR REPLACE VIEW public.runtime_schema_migration_state AS
SELECT
  EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE version = '0014_proven_patch_lifecycle'
  ) AS patch_lifecycle_applied,
  EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE version = '0015_finding_evidence_tenant_rls'
  ) AS finding_evidence_rls_applied,
  EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE version = '0016_runtime_schema_readiness_view'
  ) AS readiness_view_migration_applied,
  (SELECT max(version) FROM public.schema_migrations) AS latest_version;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    REVOKE ALL ON public.schema_migrations FROM serpvera_app;
    GRANT SELECT ON public.runtime_schema_migration_state TO serpvera_app;
  END IF;
END $$;

COMMENT ON VIEW public.runtime_schema_migration_state IS
  'Runtime readiness only: required migration flags and latest version; no checksums.';

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0016_runtime_schema_readiness_view', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
