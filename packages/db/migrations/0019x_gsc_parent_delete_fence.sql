-- Prevent parent-row cascades from mutating GSC jobs/metrics during cleanup.

BEGIN;

DO $fence$
DECLARE
  runtime_role OID;
BEGIN
  SELECT oid INTO runtime_role FROM pg_roles WHERE rolname = 'serpvera_app';
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'serpvera_app must exist before GSC parent-delete fence';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid IN (
       'public.gsc_connections'::regclass,
       'public.projects'::regclass,
       'public.organizations'::regclass
     )
       AND relowner = runtime_role
  ) THEN
    RAISE EXCEPTION 'serpvera_app must not own GSC cascade parents';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = runtime_role) THEN
    RAISE EXCEPTION 'serpvera_app must not be a member of another role during the GSC parent-delete fence';
  END IF;
END
$fence$;

REVOKE DELETE, TRUNCATE
  ON public.gsc_connections, public.projects, public.organizations
  FROM serpvera_app;

DO $verify_fence$
BEGIN
  IF has_table_privilege('serpvera_app', 'public.gsc_connections', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.gsc_connections', 'TRUNCATE')
     OR has_table_privilege('serpvera_app', 'public.projects', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.projects', 'TRUNCATE')
     OR has_table_privilege('serpvera_app', 'public.organizations', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.organizations', 'TRUNCATE') THEN
    RAISE EXCEPTION 'GSC parent-delete fence could not revoke all cascade-capable privileges';
  END IF;
END
$verify_fence$;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0019x_gsc_parent_delete_fence', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
