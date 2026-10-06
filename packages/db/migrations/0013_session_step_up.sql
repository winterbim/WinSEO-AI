-- Short-lived, user/session-bound result of a server-verified TOTP check.

BEGIN;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS step_up_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS step_up_mfa_counter BIGINT;

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_step_up_pair_valid,
  ADD CONSTRAINT sessions_step_up_pair_valid CHECK (
    (step_up_verified_at IS NULL AND step_up_mfa_counter IS NULL) OR
    (step_up_verified_at IS NOT NULL AND step_up_mfa_counter IS NOT NULL AND step_up_mfa_counter >= 0)
  );

INSERT INTO schema_migrations (version, checksum)
VALUES ('0013_session_step_up', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
