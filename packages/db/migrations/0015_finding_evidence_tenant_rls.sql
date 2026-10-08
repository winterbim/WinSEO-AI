-- Tenant-scope evidence links and enforce that both endpoints share a tenant.
-- 0004 is retained as historical migration; this forward migration repairs the
-- link table without deleting or silently dropping any pre-existing relation.

BEGIN;

ALTER TABLE finding_evidence
  ADD COLUMN IF NOT EXISTS organization_id UUID;

-- Existing rows get their tenant from the finding. The validation below also
-- checks the evidence endpoint, so an old cross-organization link aborts this
-- migration instead of being reassigned or discarded.
UPDATE finding_evidence fe
   SET organization_id = f.organization_id
  FROM findings f
 WHERE fe.finding_id = f.id
   AND fe.organization_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM finding_evidence fe
      JOIN findings f ON f.id = fe.finding_id
      JOIN evidence_items e ON e.id = fe.evidence_id
     WHERE fe.organization_id IS DISTINCT FROM f.organization_id
        OR fe.organization_id IS DISTINCT FROM e.organization_id
  ) THEN
    RAISE EXCEPTION
      'cannot tenant-scope finding_evidence: existing links cross organizations';
  END IF;

  IF EXISTS (SELECT 1 FROM finding_evidence WHERE organization_id IS NULL) THEN
    RAISE EXCEPTION
      'cannot tenant-scope finding_evidence: an existing link has no organization';
  END IF;
END $$;

ALTER TABLE finding_evidence
  ALTER COLUMN organization_id SET NOT NULL;

-- PostgreSQL requires a unique key on the complete referenced column list for
-- composite FKs. `id` is already globally unique; these indexes make the
-- organization/id pairing available as a declarative tenant-integrity check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_findings_organization_id_id
  ON findings (organization_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_items_organization_id_id
  ON evidence_items (organization_id, id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'finding_evidence'::regclass
       AND conname = 'finding_evidence_organization_id_fkey'
  ) THEN
    ALTER TABLE finding_evidence
      ADD CONSTRAINT finding_evidence_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'finding_evidence'::regclass
       AND conname = 'finding_evidence_organization_finding_fkey'
  ) THEN
    ALTER TABLE finding_evidence
      ADD CONSTRAINT finding_evidence_organization_finding_fkey
      FOREIGN KEY (organization_id, finding_id)
      REFERENCES findings(organization_id, id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'finding_evidence'::regclass
       AND conname = 'finding_evidence_organization_evidence_fkey'
  ) THEN
    ALTER TABLE finding_evidence
      ADD CONSTRAINT finding_evidence_organization_evidence_fkey
      FOREIGN KEY (organization_id, evidence_id)
      REFERENCES evidence_items(organization_id, id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE finding_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON finding_evidence;
CREATE POLICY tenant_isolation ON finding_evidence FOR ALL
  USING (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.current_organization_id', true), '')::uuid
  );

INSERT INTO schema_migrations (version, checksum)
VALUES ('0015_finding_evidence_tenant_rls', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
