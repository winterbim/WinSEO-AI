-- 0003_sessions.sql — Server-side sessions (P-GAP-05)
-- Cookie carries an OPAQUE random token only; the server holds all session state.
-- This makes logout a real server-side revocation, not just a cookie clear.

CREATE TABLE IF NOT EXISTS sessions (
  token_hash       TEXT PRIMARY KEY,          -- SHA-256 hex of the opaque cookie token (never the token itself)
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,             -- denormalized snapshot at issue time
  organization_id  UUID REFERENCES organizations(id) ON DELETE SET NULL,
  role             TEXT,                      -- role within organization_id at issue/rotation time
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  revoked_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions(organization_id) WHERE organization_id IS NOT NULL;

-- Runtime role privileges (never DDL — only data access on this table).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0003_sessions', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

-- Note: `sessions` is intentionally NOT RLS-protected: rows are addressed only by
-- the unguessable token_hash (43-char base64url secret) or by user_id during
-- authenticated logout-all. It holds no cross-tenant resource data; the
-- organization_id it references is re-verified against memberships on use.
