-- Remove runtime write privileges before the guarded historical cleanup.
-- A custom GUC is user-settable and must never be the security boundary.

BEGIN;

DO $fence$
DECLARE
  runtime_role OID;
BEGIN
  SELECT oid INTO runtime_role FROM pg_roles WHERE rolname = 'serpvera_app';
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'serpvera_app must exist before GSC write-fence migration';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid IN ('public.gsc_sync_jobs'::regclass, 'public.gsc_query_metrics'::regclass)
       AND relowner = runtime_role
  ) THEN
    RAISE EXCEPTION 'serpvera_app must not own GSC tables; migrations require a separate owner role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = runtime_role) THEN
    RAISE EXCEPTION 'serpvera_app must not be a member of another role during the GSC migration fence';
  END IF;
END
$fence$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.gsc_sync_jobs, public.gsc_query_metrics
  FROM serpvera_app;

DO $verify_fence$
BEGIN
  IF has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'TRUNCATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'TRUNCATE') THEN
    RAISE EXCEPTION 'GSC write fence could not revoke all runtime write privileges';
  END IF;
END
$verify_fence$;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0019y_gsc_sync_write_fence', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
