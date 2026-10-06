-- Tenant-scoped persistence for the fixture-only proven patch workflow.
-- The API never exposes the WordPress adapter from this migration's feature.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_id_organization
  ON projects(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_id_organization
  ON findings(id, organization_id);

CREATE TABLE IF NOT EXISTS patch_proposals (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'detected', 'proposed', 'previewed', 'approved', 'deploying', 'deployed',
    'deployed_manually', 'live_verified', 'rolled_back', 'failed', 'rejected', 'superseded'
  )),
  version INT NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  proposal_json JSONB NOT NULL,
  fixture_html TEXT NOT NULL,
  event_count INT NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (finding_id, organization_id)
    REFERENCES findings(id, organization_id) ON DELETE CASCADE,
  UNIQUE (id, organization_id)
);

CREATE INDEX IF NOT EXISTS idx_patch_proposals_org_project
  ON patch_proposals(organization_id, project_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_patch_proposals_finding
  ON patch_proposals(organization_id, finding_id);

CREATE TABLE IF NOT EXISTS patch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  patch_id UUID NOT NULL,
  event_number INT NOT NULL CHECK (event_number > 0),
  actor_user_id UUID,
  event_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (patch_id, event_number),
  FOREIGN KEY (patch_id, organization_id)
    REFERENCES patch_proposals(id, organization_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_patch_events_tenant_patch
  ON patch_events(organization_id, patch_id, event_number);

ALTER TABLE patch_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON patch_proposals;
CREATE POLICY tenant_isolation ON patch_proposals
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

ALTER TABLE patch_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON patch_events;
CREATE POLICY tenant_isolation ON patch_events
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

CREATE OR REPLACE FUNCTION forbid_patch_event_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'patch_events is append-only: UPDATE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS patch_events_immutable ON patch_events;
CREATE TRIGGER patch_events_immutable
  BEFORE UPDATE ON patch_events
  FOR EACH ROW EXECUTE FUNCTION forbid_patch_event_update();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT, UPDATE ON patch_proposals TO serpvera_app;
    GRANT SELECT, INSERT ON patch_events TO serpvera_app;
    REVOKE UPDATE, DELETE ON patch_events FROM serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0011_proven_patches', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
