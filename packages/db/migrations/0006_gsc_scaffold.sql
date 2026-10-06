-- 0006_gsc_scaffold.sql — credential-independent GSC ingestion architecture.
-- No Google token is stored here. `credential_ref` is an opaque reference to a
-- secret manager entry; fixtures can exercise adapters/jobs without credentials.

CREATE TABLE IF NOT EXISTS gsc_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_property TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'site',
  credential_ref TEXT,
  status TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (status IN ('DISCONNECTED', 'CONNECTED', 'ERROR')),
  connected_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, external_property)
);

CREATE TABLE IF NOT EXISTS gsc_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES gsc_connections(id) ON DELETE CASCADE,
  window_start DATE NOT NULL,
  window_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CREDENTIALS_REQUIRED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  row_count INT NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  CHECK (window_end >= window_start)
);

CREATE TABLE IF NOT EXISTS gsc_query_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sync_job_id UUID NOT NULL REFERENCES gsc_sync_jobs(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  clicks DOUBLE PRECISION NOT NULL CHECK (clicks >= 0),
  impressions DOUBLE PRECISION NOT NULL CHECK (impressions >= 0),
  ctr DOUBLE PRECISION NOT NULL CHECK (ctr >= 0 AND ctr <= 1),
  position DOUBLE PRECISION NOT NULL CHECK (position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sync_job_id, metric_date, query, page, country, device)
);

CREATE INDEX IF NOT EXISTS idx_gsc_connections_project ON gsc_connections(project_id);
CREATE INDEX IF NOT EXISTS idx_gsc_jobs_project_status ON gsc_sync_jobs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_gsc_metrics_project_date ON gsc_query_metrics(project_id, metric_date);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gsc_connections', 'gsc_sync_jobs', 'gsc_query_metrics'] LOOP
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
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      gsc_connections, gsc_sync_jobs, gsc_query_metrics TO serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0006_gsc_scaffold', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
