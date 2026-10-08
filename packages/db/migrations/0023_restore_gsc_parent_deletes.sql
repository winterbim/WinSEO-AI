-- Restore supported project/organization/connection deletion after cleanup.
-- TRUNCATE remains ungranted; ordinary product flows use scoped DELETE.

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
    RAISE EXCEPTION 'GSC migration guard must be removed before parent deletes are restored';
  END IF;
END
$restore$;

GRANT DELETE
  ON public.gsc_connections, public.projects, public.organizations
  TO serpvera_app;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0023_restore_gsc_parent_deletes', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
