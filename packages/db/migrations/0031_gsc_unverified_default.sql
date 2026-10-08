-- Keep jobs unverified until the current collector completes them. This is
-- safe during rolling deployments: an older worker cannot promote its job.

BEGIN;

ALTER TABLE gsc_sync_jobs
  ALTER COLUMN ingestion_version SET DEFAULT 0;

UPDATE gsc_sync_jobs
   SET ingestion_version = 0
 WHERE status <> 'COMPLETED' OR completed_at IS NULL;

COMMENT ON COLUMN gsc_sync_jobs.ingestion_version IS
  'Collector contract verified at successful completion. 0 means historical, pending, or otherwise unverified; 1 means completed by the bounded, deduplicating Search Analytics collector.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('0031_gsc_unverified_default', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
