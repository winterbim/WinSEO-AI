-- Product TOTP factors. The API persists only AES-GCM ciphertext; the seed is
-- encrypted before it reaches PostgreSQL and is never serialized by routes.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_secret_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_enrollment_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mfa_last_counter BIGINT NOT NULL DEFAULT -1;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_mfa_last_counter_valid,
  ADD CONSTRAINT users_mfa_last_counter_valid CHECK (mfa_last_counter >= -1),
  DROP CONSTRAINT IF EXISTS users_mfa_enabled_requires_secret,
  ADD CONSTRAINT users_mfa_enabled_requires_secret
    CHECK (mfa_enabled_at IS NULL OR mfa_secret_ciphertext IS NOT NULL),
  DROP CONSTRAINT IF EXISTS users_mfa_enrollment_exclusive,
  ADD CONSTRAINT users_mfa_enrollment_exclusive
    CHECK (mfa_enrollment_expires_at IS NULL OR mfa_enabled_at IS NULL);

INSERT INTO schema_migrations (version, checksum)
VALUES ('0012_totp_mfa', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
