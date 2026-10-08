-- Keep each capture's tenant key directly anchored to the organization as well
-- as transitively scoped by its composite project/import foreign key.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'ai_visibility_captures_organization_id_fkey'
       AND conrelid = 'ai_visibility_captures'::regclass
  ) THEN
    ALTER TABLE ai_visibility_captures
      ADD CONSTRAINT ai_visibility_captures_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES organizations(id)
      ON DELETE CASCADE;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0026_ai_visibility_capture_org_fk', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
