BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS create_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS projects_org_create_idempotency_key_uq
  ON projects (organization_id, create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0017_project_create_idempotency', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
