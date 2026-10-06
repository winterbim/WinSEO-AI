-- 0007_gsc_live.sql — real Google OAuth material for live GSC ingestion.
--
-- Scope guard: this migration defines WHERE token material lives and how the
-- single-use OAuth state is tracked. It stores NO credential values itself —
-- the application envelope-encrypts tokens (AES-256-GCM) before INSERT, and the
-- columns below are ciphertext only. Nothing here is reachable without a real
-- Google authorization; without credentials the API reports BLOCKED instead of
-- fabricating metrics.

-- One Google authorization per WinSEO project. `gsc_connections.credential_ref`
-- (0006) points at this row's id — the scaffold's opaque secret reference.
CREATE TABLE IF NOT EXISTS gsc_project_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Envelope ciphertexts: `v1.<iv>.<tag>.<ciphertext>` (see integrations/gsc/crypto.ts).
  encrypted_refresh_token TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT NOT NULL,
  -- Google `sub` — stable account identifier, never an email or token.
  google_subject TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id)
);

-- Single-use OAuth state + PKCE verifier. Stored server-side so `state` is
-- validated against a record the client cannot forge, replay, or extend.
CREATE TABLE IF NOT EXISTS gsc_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash TEXT NOT NULL UNIQUE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retry/idempotency inputs for the ingestion job (0006 defines the job row).
ALTER TABLE gsc_sync_jobs
  ADD COLUMN IF NOT EXISTS attempt INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- The same (connection, window) job is only ever one row: retries update it in
-- place instead of creating twins, so a retried window cannot double-count.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gsc_jobs_idempotency
  ON gsc_sync_jobs (connection_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_gsc_credentials_org ON gsc_project_credentials (organization_id);
CREATE INDEX IF NOT EXISTS idx_gsc_oauth_states_project ON gsc_oauth_states (project_id);

-- ── RLS: token material and OAuth state are tenant-owned like everything else ──
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gsc_project_credentials', 'gsc_oauth_states'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($policy$
      CREATE POLICY tenant_isolation ON %I FOR ALL
      USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
      WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
    $policy$, t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    -- 0006 already granted full DML on gsc_sync_jobs; the new retry/idempotency
    -- columns inherit that table-level UPDATE.
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      gsc_project_credentials, gsc_oauth_states TO serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0007_gsc_live', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
