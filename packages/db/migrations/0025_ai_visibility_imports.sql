-- Persist user-submitted AI visibility CSV captures as immutable, tenant-owned
-- imports. This records what a user submitted; it does not authenticate an AI
-- provider response.

BEGIN;

CREATE TABLE IF NOT EXISTS ai_visibility_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  csv_sha256 TEXT NOT NULL CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),
  row_count INT NOT NULL CHECK (row_count BETWEEN 1 AND 5000),
  provenance TEXT NOT NULL DEFAULT 'USER_SUPPLIED'
    CHECK (provenance = 'USER_SUPPLIED'),
  epistemic_class TEXT NOT NULL DEFAULT 'DOCUMENTED'
    CHECK (epistemic_class = 'DOCUMENTED'),
  unverified_by_provider BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (unverified_by_provider = TRUE),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  UNIQUE (organization_id, project_id, id),
  UNIQUE (organization_id, project_id, csv_sha256)
);

CREATE TABLE IF NOT EXISTS ai_visibility_captures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  project_id UUID NOT NULL,
  import_id UUID NOT NULL,
  row_number INT NOT NULL CHECK (row_number BETWEEN 1 AND 5000),
  engine TEXT NOT NULL CHECK (length(engine) BETWEEN 1 AND 100),
  prompt_id TEXT NOT NULL CHECK (length(prompt_id) BETWEEN 1 AND 500),
  brand_mentioned BOOLEAN NOT NULL,
  client_cited BOOLEAN NOT NULL,
  citation_domains TEXT[] NOT NULL DEFAULT '{}',
  sampled_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(citation_domains) <= 50),
  FOREIGN KEY (organization_id, project_id, import_id)
    REFERENCES ai_visibility_imports(organization_id, project_id, id) ON DELETE CASCADE,
  UNIQUE (organization_id, project_id, import_id, row_number)
);

CREATE INDEX IF NOT EXISTS ai_visibility_imports_project_history_idx
  ON ai_visibility_imports (organization_id, project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ai_visibility_captures_project_group_idx
  ON ai_visibility_captures (organization_id, project_id, engine, prompt_id, sampled_at DESC);

ALTER TABLE ai_visibility_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_visibility_imports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_visibility_imports;
CREATE POLICY tenant_isolation ON ai_visibility_imports
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

ALTER TABLE ai_visibility_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_visibility_captures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ai_visibility_captures;
CREATE POLICY tenant_isolation ON ai_visibility_captures
  FOR ALL
  USING (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT ON ai_visibility_imports, ai_visibility_captures TO serpvera_app;
    REVOKE UPDATE, DELETE ON ai_visibility_imports, ai_visibility_captures FROM serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0025_ai_visibility_imports', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
