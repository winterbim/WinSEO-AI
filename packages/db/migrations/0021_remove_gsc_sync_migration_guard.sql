-- Reopen Search Console writes only after the 0020 cleanup has committed.

BEGIN;

DROP TRIGGER IF EXISTS gsc_sync_jobs_migration_guard ON public.gsc_sync_jobs;
DROP TRIGGER IF EXISTS gsc_query_metrics_migration_guard ON public.gsc_query_metrics;
DROP FUNCTION IF EXISTS public.guard_gsc_writes_during_migration();
DROP TABLE IF EXISTS public.gsc_migration_guard;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0021_remove_gsc_sync_migration_guard', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
