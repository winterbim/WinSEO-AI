-- 0004_findings_scope.sql — Evidence Ledger detail (PHASE-3-UI)
-- Adds what the authenticated dashboard must show per finding:
--   * affected_urls  — the concrete URLs the rule fired on (Blueprint §1.2 scope)
--   * verification_gate — the declared gate for this rule (Blueprint §13.2:
--     every rule contract carries its gate; stored at insert so the finding is
--     reproducible even if the rule catalog changes later)
--   * finding_evidence — explicit finding↔evidence links (Blueprint §11.3) so
--     a finding detail can show WHICH evidence supports it, not just "some
--     evidence exists somewhere".

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS affected_urls TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS verification_gate TEXT NOT NULL DEFAULT 'recrawl_rule_absent';

CREATE TABLE IF NOT EXISTS finding_evidence (
  finding_id UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'supports',
  PRIMARY KEY (finding_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_finding_evidence_evidence
  ON finding_evidence(evidence_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON finding_evidence TO serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0004_findings_scope', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;