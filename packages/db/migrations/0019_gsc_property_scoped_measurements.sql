-- A project reports one active Search Console property at a time. Historical
-- rows remain keyed by their sync job, so selecting the active property never
-- combines overlapping properties into one measured dataset.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gsc_connections
     WHERE status = 'CONNECTED'
     GROUP BY organization_id, project_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot enable property-scoped GSC measurements: a project has multiple connected properties; disconnect all but the intended property and retry';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS gsc_connections_one_connected_per_project_uq
  ON gsc_connections (organization_id, project_id)
  WHERE status = 'CONNECTED';

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0019_gsc_property_scoped_measurements', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
