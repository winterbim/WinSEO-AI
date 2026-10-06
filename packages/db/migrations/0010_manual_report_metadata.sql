-- Keep the legacy implementation description but remove names that imply a
-- verified write. The values are renamed, not discarded; the historical
-- action_transitions payload remains immutable and is preserved as authored.

BEGIN;

UPDATE actions
   SET implementation_json =
         (implementation_json - 'implementedAt' - 'implementedBy' - 'implementedByEmail')
         || jsonb_strip_nulls(jsonb_build_object(
              'reportedAt', implementation_json->'implementedAt',
              'reportedBy', implementation_json->'implementedBy',
              'reportedByEmail', implementation_json->'implementedByEmail'
            ))
 WHERE implementation_json ?| ARRAY['implementedAt', 'implementedBy', 'implementedByEmail'];

INSERT INTO schema_migrations (version, checksum)
VALUES ('0010_manual_report_metadata', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
