-- Distinguish historical Search Console jobs from jobs created by the bounded
-- current ingestion pipeline. Existing rows receive version 0 and remain
-- stored, but are not accepted as current measurement evidence.

BEGIN;

ALTER TABLE gsc_sync_jobs
  ADD COLUMN IF NOT EXISTS ingestion_version INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'gsc_sync_jobs_ingestion_version_nonnegative'
       AND conrelid = 'gsc_sync_jobs'::regclass
  ) THEN
    ALTER TABLE gsc_sync_jobs
      ADD CONSTRAINT gsc_sync_jobs_ingestion_version_nonnegative
      CHECK (ingestion_version >= 0);
  END IF;
END $$;

ALTER TABLE gsc_sync_jobs
  ALTER COLUMN ingestion_version SET DEFAULT 1;

COMMENT ON COLUMN gsc_sync_jobs.ingestion_version IS
  'Ingestion contract that produced the job. 0 means historical/unverified; 1 is the bounded, deduplicating Search Analytics collector.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('0030_gsc_sync_ingestion_version', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
