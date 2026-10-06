-- WinSEO / SERPVERA — 0008_distributed_rate_limits.sql
-- Shared anonymous public-scan quota across API instances.

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket_key     TEXT PRIMARY KEY,
  request_count  INTEGER NOT NULL CHECK (request_count > 0),
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_expires
  ON rate_limit_windows (expires_at);

COMMENT ON TABLE rate_limit_windows IS
  'Global API rate-limit counters; bucket_key contains an HMAC IP fingerprint, never a raw IP.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_windows TO serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0008_distributed_rate_limits', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
