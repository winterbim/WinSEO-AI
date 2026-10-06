-- Reclassify the old Action Center's descriptive "IMPLEMENTED" status.
-- It recorded a user statement; it did not write to a site or verify a live page.
-- Preserve every old transition and append an explicit migration event.

BEGIN;

ALTER TABLE actions
  DROP CONSTRAINT IF EXISTS actions_state_check;

WITH migrated AS (
  UPDATE actions
     SET state = 'REPORTED_MANUALLY',
         version = version + 1,
         updated_at = now()
   WHERE state = 'IMPLEMENTED'
   RETURNING id, organization_id, version
)
INSERT INTO action_transitions
  (organization_id, action_id, from_state, to_state, actor_user_id,
   actor_email, payload, action_version)
SELECT organization_id, id, 'IMPLEMENTED', 'REPORTED_MANUALLY', NULL,
       'system:migration-0009',
       jsonb_build_object(
         'migration', '0009_reported_manually',
         'reason', 'The previous status stored a manual report, not a verified deployment.'
       ),
       version
  FROM migrated;

ALTER TABLE actions
  ADD CONSTRAINT actions_state_check CHECK (state IN (
    'DETECTED', 'EVIDENCED', 'PROPOSED', 'APPROVED', 'REPORTED_MANUALLY',
    'MEASURING', 'VERIFIED', 'REJECTED', 'INCONCLUSIVE', 'CLOSED'
  ));

INSERT INTO schema_migrations (version, checksum)
VALUES ('0009_reported_manually', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
