-- Refuse the destructive legacy-overlap cleanup in 0020 when client clocks
-- reverse the database request order for completed fetches with overlapping
-- metric rows. The migration runner applies this lexically before 0020.
-- Ambiguous history is preserved for operator review instead of guessed at.

BEGIN;

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
            AND metric.sync_job_id IN (first_job.id, second_job.id)
            AND metric.metric_date BETWEEN
                GREATEST(first_job.window_start, second_job.window_start)
                AND LEAST(first_job.window_end, second_job.window_end)
       )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = '0020 GSC claim-order cleanup blocked: overlapping completed jobs have client-clock order that conflicts with database request order; preserve rows and resolve history before migrating';
  END IF;
END
$preflight$;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0019z_gsc_claim_order_preflight', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
