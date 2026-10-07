-- Extend runtime readiness to cover the project-create idempotency migration,
-- and retain compatibility with older application binaries that insert into
-- finding_evidence without the organization_id column added in 0015.

BEGIN;

CREATE OR REPLACE FUNCTION public.populate_finding_evidence_organization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    SELECT f.organization_id
      INTO NEW.organization_id
      FROM public.findings AS f
     WHERE f.id = NEW.finding_id;

    IF NEW.organization_id IS NULL THEN
      RAISE EXCEPTION 'finding is unavailable in the current tenant scope'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.populate_finding_evidence_organization() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT EXECUTE ON FUNCTION public.populate_finding_evidence_organization() TO serpvera_app;
  END IF;
END $$;

DROP TRIGGER IF EXISTS finding_evidence_fill_organization ON public.finding_evidence;
CREATE TRIGGER finding_evidence_fill_organization
BEFORE INSERT ON public.finding_evidence
FOR EACH ROW EXECUTE FUNCTION public.populate_finding_evidence_organization();

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
  (SELECT max(version) FROM public.schema_migrations) AS latest_version,
  EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE version = '0017_project_create_idempotency'
  ) AS project_create_idempotency_applied,
  EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE version = '0018_runtime_readiness_and_legacy_evidence_compat'
  ) AS current_readiness_view_applied,
  EXISTS (
    SELECT 1 FROM public.schema_migrations
     WHERE version = '0019_gsc_property_scoped_measurements'
  ) AS gsc_property_scoping_applied;

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
VALUES ('0018_runtime_readiness_and_legacy_evidence_compat', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
