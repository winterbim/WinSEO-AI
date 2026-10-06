-- 0005_action_center.sql — operational Action Center + deterministic verification
--
-- Actions already exist from 0001. This migration adds the immutable inputs and
-- outputs needed to operate the state machine without replacing evidence with
-- prose: recommendation + declared gate, implementation/rollback metadata,
-- baseline/window, deterministic verification, optimistic version and history.

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS crawl_run_id UUID REFERENCES crawl_runs(id) ON DELETE SET NULL;

ALTER TABLE evidence_items
  ADD COLUMN IF NOT EXISTS crawl_run_id UUID REFERENCES crawl_runs(id) ON DELETE SET NULL;

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS recommendation_json JSONB,
  ADD COLUMN IF NOT EXISTS verification_gate TEXT,
  ADD COLUMN IF NOT EXISTS implementation_json JSONB,
  ADD COLUMN IF NOT EXISTS rollback_json JSONB,
  ADD COLUMN IF NOT EXISTS baseline_json JSONB,
  ADD COLUMN IF NOT EXISTS comparison_window_json JSONB,
  ADD COLUMN IF NOT EXISTS verification_json JSONB;

-- Existing DETECTED rows inherit the finding's gate. New rows snapshot it at
-- creation time in the repository, so later rule-catalog changes cannot rewrite
-- what an approved recommendation promised to verify.
UPDATE actions a
   SET verification_gate = f.verification_gate
  FROM findings f
 WHERE f.id = a.finding_id AND a.verification_gate IS NULL;

ALTER TABLE actions
  DROP CONSTRAINT IF EXISTS actions_version_positive,
  ADD CONSTRAINT actions_version_positive CHECK (version > 0),
  DROP CONSTRAINT IF EXISTS actions_state_check,
  ADD CONSTRAINT actions_state_check CHECK (state IN (
    'DETECTED', 'EVIDENCED', 'PROPOSED', 'APPROVED', 'IMPLEMENTED',
    'MEASURING', 'VERIFIED', 'REJECTED', 'INCONCLUSIVE', 'CLOSED'
  ));

-- One operational workflow per finding. Fail loudly if historic duplicates
-- exist instead of choosing a winner and destroying provenance silently.
CREATE UNIQUE INDEX IF NOT EXISTS uq_actions_finding ON actions(finding_id);
CREATE INDEX IF NOT EXISTS idx_findings_crawl_run ON findings(crawl_run_id);
CREATE INDEX IF NOT EXISTS idx_evidence_crawl_run ON evidence_items(crawl_run_id);

CREATE TABLE IF NOT EXISTS action_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  -- Action version AFTER this transition (enables replay + conflict forensics).
  action_version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_transitions_action
  ON action_transitions(action_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_action_transitions_org
  ON action_transitions(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_action_transitions_version
  ON action_transitions(action_id, action_version);

-- ── RLS: history is tenant-owned like everything else ──
ALTER TABLE action_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_transitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON action_transitions;
CREATE POLICY tenant_isolation ON action_transitions
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

-- Runtime history is append-only. Account erasure remains possible through the
-- organization/action ON DELETE CASCADE when performed by the admin data-erasure
-- path; the application role can neither rewrite nor directly delete history.
CREATE OR REPLACE FUNCTION forbid_action_transition_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'action_transitions is append-only: UPDATE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS action_transitions_immutable ON action_transitions;
CREATE TRIGGER action_transitions_immutable
  BEFORE UPDATE ON action_transitions
  FOR EACH ROW EXECUTE FUNCTION forbid_action_transition_update();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT, UPDATE ON actions TO serpvera_app;
    GRANT SELECT, INSERT ON action_transitions TO serpvera_app;
    REVOKE UPDATE, DELETE ON action_transitions FROM serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0005_action_center', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
