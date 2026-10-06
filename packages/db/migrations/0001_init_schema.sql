-- ═══════════════════════════════════════════════════════════════
-- WinSEO / SERPVERA — 0001_init_schema.sql
-- Authoritative, idempotent migration: schema + RLS + indexes.
-- Applied by an ADMIN role (superuser) ONLY. See bootstrap.sql for roles.
-- Safe to execute repeatedly: guards every CREATE POLICY with DROP IF EXISTS,
-- every table with IF NOT EXISTS, and records execution in schema_migrations.
-- Source: Blueprint §11, SECURITY_MODEL §5, ADR-002.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Migration ledger (prevents double-application ambiguity) ───
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by  TEXT NOT NULL DEFAULT current_user,
  checksum    TEXT
);

-- ═══════════════════════════════════════════════════════════════
-- CORE IDENTITY (not tenant-owned: organizations/memberships are the tenant root
-- and cross-org auth joins; they are NOT RLS-guarded but are access-controlled in app)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  auth_subject  TEXT UNIQUE,
  name          TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  plan_id    TEXT NOT NULL DEFAULT 'free',
  region     TEXT DEFAULT 'auto',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS memberships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'VIEWER',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id)
);

CREATE TABLE IF NOT EXISTS plans (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE,
  price_monthly_cents INT NOT NULL,
  sites_limit        INT NOT NULL,
  crawl_urls_limit   INT NOT NULL,
  gsc_enabled        BOOLEAN DEFAULT false,
  ai_checks_limit    INT NOT NULL,
  history_days       INT NOT NULL DEFAULT 30,
  exports_enabled    BOOLEAN DEFAULT false,
  team_members_limit INT NOT NULL DEFAULT 1,
  competitor_limit   INT NOT NULL DEFAULT 0,
  api_access         BOOLEAN DEFAULT false,
  white_label        BOOLEAN DEFAULT false
);

-- ═══════════════════════════════════════════════════════════════
-- TENANT-OWNED (every row carries organization_id; RLS enforced)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  primary_domain  TEXT NOT NULL,
  timezone        TEXT DEFAULT 'UTC',
  default_locale  TEXT DEFAULT 'en',
  status          TEXT DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL,
  seed_strategy   TEXT NOT NULL DEFAULT 'SITEMAP',
  engine_version  TEXT NOT NULL DEFAULT '0.1.0',
  status          TEXT NOT NULL DEFAULT 'pending',
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  pages_crawled   INT DEFAULT 0,
  pages_failed    INT DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS findings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL,
  rule_version    TEXT NOT NULL,
  rule_hash       TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  epistemic_class TEXT NOT NULL,
  severity        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  confidence      REAL NOT NULL DEFAULT 1.0,
  explanation     TEXT,
  recommendation  TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  source_ref      TEXT NOT NULL,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash    TEXT NOT NULL,
  object_key      TEXT NOT NULL,
  metadata_json   JSONB
);

CREATE TABLE IF NOT EXISTS actions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id             UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  finding_id             UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  recommendation_version TEXT NOT NULL DEFAULT '1.0.0',
  priority_index         REAL NOT NULL DEFAULT 0,
  state                  TEXT NOT NULL DEFAULT 'DETECTED',
  owner_user_id          UUID REFERENCES users(id),
  business_value         REAL DEFAULT 0,
  evidence_strength      REAL DEFAULT 0,
  impact_hypothesis      REAL DEFAULT 0,
  confidence             REAL DEFAULT 0,
  effort                 REAL DEFAULT 0,
  risk_factor            REAL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (ADR-002, SECURITY_MODEL §5)
-- ENABLE + FORCE means even the table OWNER is subject to policy.
-- Only superuser / BYPASSRLS roles escape; the runtime role is neither.
-- ═══════════════════════════════════════════════════════════════
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects','crawl_runs','findings','evidence_items','actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    -- Idempotent policy: drop then create.
    -- NULL-safe: nullif('','')→NULL so an unset OR empty tenant setting matches
    -- ZERO rows (organization_id = NULL is never true). ''::uuid would ERROR,
    -- so we must coalesce empty→NULL before the cast. Defense in depth: a pooled
    -- connection with a stale/cleared setting still cannot read any tenant rows.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
        WITH CHECK (organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid)
    $f$, t);
  END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
CREATE INDEX IF NOT EXISTS idx_findings_project ON findings(project_id);
CREATE INDEX IF NOT EXISTS idx_findings_org ON findings(organization_id);
CREATE INDEX IF NOT EXISTS idx_evidence_org ON evidence_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id);

-- ═══════════════════════════════════════════════════════════════
-- Runtime role grants (role created in bootstrap.sql). Idempotent.
-- serpvera_app: NOLOGIN-agnostic runtime role, non-superuser, non-bypassrls.
-- ═══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT CONNECT ON DATABASE serpvera_dev TO serpvera_app;
    GRANT USAGE ON SCHEMA public TO serpvera_app;
    -- Core identity + reference: CRUD (access further restricted in app layer)
    GRANT SELECT, INSERT, UPDATE, DELETE ON users, organizations, memberships TO serpvera_app;
    GRANT SELECT ON plans TO serpvera_app;
    -- Tenant-owned: CRUD, but RLS filters rows to current tenant
    GRANT SELECT, INSERT, UPDATE, DELETE ON projects, crawl_runs, findings, evidence_items, actions TO serpvera_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO serpvera_app;
  END IF;
END $$;

-- ─── Record migration in ledger (idempotent) ───
INSERT INTO schema_migrations (version, checksum)
VALUES ('0001_init_schema', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
