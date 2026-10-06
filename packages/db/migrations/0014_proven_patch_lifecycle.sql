-- Complete the persistent status vocabulary for the proven patch lifecycle.
-- Google observations, measurement, and drift jobs remain disabled until M7/M8.

BEGIN;

ALTER TABLE patch_proposals
  DROP CONSTRAINT IF EXISTS patch_proposals_status_check;

ALTER TABLE patch_proposals
  ADD CONSTRAINT patch_proposals_status_check CHECK (status IN (
    'detected', 'proposed', 'previewed', 'approved', 'deploying', 'deployed',
    'deployed_manually', 'live_verified', 'google_observed', 'measuring',
    'measured', 'rolled_back', 'superseded', 'drifted', 'failed', 'rejected'
  ));

INSERT INTO schema_migrations (version, checksum)
VALUES ('0014_proven_patch_lifecycle', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
