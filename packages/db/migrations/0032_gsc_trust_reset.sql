-- Jobs written before this migration cannot be attributed to the bounded
-- collector. Reset every stored marker so only a successful post-migration
-- collection can establish measurement trust.

BEGIN;

ALTER TABLE gsc_sync_jobs
  ALTER COLUMN ingestion_version SET DEFAULT 0;

UPDATE gsc_sync_jobs
   SET ingestion_version = 0
 WHERE ingestion_version <> 0;

COMMENT ON COLUMN gsc_sync_jobs.ingestion_version IS
  'Collector contract verified at successful completion after the trust-reset migration. 0 means historical, pending, or otherwise unverified; 1 means completed by the bounded, deduplicating Search Analytics collector.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('0032_gsc_trust_reset', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
