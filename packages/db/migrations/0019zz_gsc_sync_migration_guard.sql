-- Freeze Search Console writes between the historical preflight and the
-- cleanup in 0020. The migration runner holds the per-session bypass until
-- 0021 removes this guard; application sessions do not set that GUC.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gsc_migration_guard (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO public.gsc_migration_guard (singleton, active)
VALUES (TRUE, TRUE)
ON CONFLICT (singleton) DO UPDATE SET active = TRUE;

CREATE OR REPLACE FUNCTION public.guard_gsc_writes_during_migration()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF current_setting('app.winseo_gsc_migration', TRUE) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.gsc_migration_guard WHERE singleton AND active
  ) THEN
    RAISE EXCEPTION 'Search Console writes are paused while database migrations run';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$guard$;

DROP TRIGGER IF EXISTS gsc_sync_jobs_migration_guard ON public.gsc_sync_jobs;
CREATE TRIGGER gsc_sync_jobs_migration_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.gsc_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_gsc_writes_during_migration();

DROP TRIGGER IF EXISTS gsc_query_metrics_migration_guard ON public.gsc_query_metrics;
CREATE TRIGGER gsc_query_metrics_migration_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.gsc_query_metrics
  FOR EACH ROW EXECUTE FUNCTION public.guard_gsc_writes_during_migration();

-- Recheck after installing the write barrier. If a job arrived between 0019z
-- and this migration, the transaction aborts and 0020 is never reached.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM gsc_sync_jobs AS first_job
      JOIN gsc_sync_jobs AS second_job
        ON second_job.organization_id = first_job.organization_id
       AND second_job.project_id = first_job.project_id
       AND second_job.connection_id = first_job.connection_id
       AND second_job.id <> first_job.id
     WHERE first_job.status = 'COMPLETED'
       AND second_job.status = 'COMPLETED'
       AND ROW(
             COALESCE(first_job.started_at, first_job.requested_at),
             first_job.requested_at,
             first_job.id
           ) < ROW(
             COALESCE(second_job.started_at, second_job.requested_at),
             second_job.requested_at,
             second_job.id
           )
       AND ROW(first_job.requested_at, first_job.id)
             > ROW(second_job.requested_at, second_job.id)
       AND EXISTS (
         SELECT 1
           FROM gsc_query_metrics AS metric
          WHERE metric.organization_id = first_job.organization_id
            AND metric.project_id = first_job.project_id
            AND (
              (metric.sync_job_id = first_job.id
               AND metric.metric_date BETWEEN second_job.window_start AND second_job.window_end)
              OR
              (metric.sync_job_id = second_job.id
               AND metric.metric_date BETWEEN first_job.window_start AND first_job.window_end)
            )
       )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0020 GSC claim-order cleanup blocked: overlapping completed jobs have client-clock order that conflicts with database request order; preserve rows and resolve history before migrating';
  END IF;
END
$preflight$;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0019zz_gsc_sync_migration_guard', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
