-- Restore application writes only after 0021 has removed the migration guard.

BEGIN;

DO $restore$
BEGIN
  IF to_regclass('public.gsc_migration_guard') IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM pg_trigger
        WHERE tgrelid IN ('public.gsc_sync_jobs'::regclass, 'public.gsc_query_metrics'::regclass)
          AND tgname IN ('gsc_sync_jobs_migration_guard', 'gsc_query_metrics_migration_guard')
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'GSC migration guard must be removed before runtime writes are restored';
  END IF;
END
$restore$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.gsc_sync_jobs, public.gsc_query_metrics
  TO serpvera_app;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0022_restore_gsc_runtime_writes', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
