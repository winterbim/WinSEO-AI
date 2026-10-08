-- Restore the checked-in runtime DML baseline after all GSC maintenance guards.

BEGIN;

DO $restore$
BEGIN
  IF to_regclass('public.gsc_migration_guard') IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgrelid IN (
          'public.gsc_connections'::regclass,
          'public.gsc_sync_jobs'::regclass,
          'public.gsc_query_metrics'::regclass
        )
          AND tgname IN (
            'gsc_sync_jobs_migration_guard',
            'gsc_query_metrics_migration_guard'
          )
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'GSC migration guards must be removed before runtime ACLs are restored';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') IS FALSE THEN
    RAISE EXCEPTION 'serpvera_app must exist before restoring GSC ACLs';
  END IF;
END
$restore$;

GRANT INSERT, UPDATE, DELETE
  ON public.organizations, public.projects, public.gsc_connections,
     public.gsc_sync_jobs, public.gsc_query_metrics
  TO serpvera_app;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0024_restore_gsc_acl_baseline', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
