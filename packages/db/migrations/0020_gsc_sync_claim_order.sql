-- Assign each claimed Search Console fetch a per-property monotonic order.
-- Client timestamps are retained for display/lease semantics but are not a
-- trustworthy winner key across API instances or equal millisecond clocks.

BEGIN;

ALTER TABLE gsc_sync_jobs
  ADD COLUMN IF NOT EXISTS claim_order BIGINT NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY organization_id, project_id, connection_id
           ORDER BY COALESCE(started_at, requested_at), requested_at, id
         ) AS claim_order
    FROM gsc_sync_jobs
)
UPDATE gsc_sync_jobs AS job
   SET claim_order = ranked.claim_order
  FROM ranked
 WHERE ranked.id = job.id
   AND job.claim_order = 0;

CREATE UNIQUE INDEX IF NOT EXISTS gsc_sync_jobs_claim_order_uq
  ON gsc_sync_jobs (organization_id, project_id, connection_id, claim_order)
  WHERE claim_order > 0;

-- Remove stale overlap rows left by older deployments. The most recently
-- claimed completed fetch owns every date inside its requested window, even
-- when that fetch returned no row for a particular query.
DELETE FROM gsc_query_metrics AS metric
 USING gsc_sync_jobs AS source_job,
       gsc_sync_jobs AS newer_job
 WHERE source_job.id = metric.sync_job_id
   AND source_job.organization_id = metric.organization_id
   AND source_job.project_id = metric.project_id
   AND source_job.status = 'COMPLETED'
   AND newer_job.organization_id = source_job.organization_id
   AND newer_job.project_id = source_job.project_id
   AND newer_job.connection_id = source_job.connection_id
   AND newer_job.status = 'COMPLETED'
   AND newer_job.id <> source_job.id
   AND (newer_job.claim_order, newer_job.id) > (source_job.claim_order, source_job.id)
   AND metric.metric_date BETWEEN newer_job.window_start AND newer_job.window_end;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0020_gsc_sync_claim_order', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
