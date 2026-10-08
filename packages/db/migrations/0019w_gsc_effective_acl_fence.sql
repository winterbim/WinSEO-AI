-- Close table- and column-level write grants before the historical GSC cleanup.
-- PUBLIC column ACLs can survive REVOKE of table-level privileges, so remove
-- them explicitly and verify the runtime role has no effective write path.

BEGIN;

DO $preflight$
DECLARE
  runtime_role OID;
BEGIN
  SELECT oid INTO runtime_role FROM pg_roles WHERE rolname = 'serpvera_app';
  IF runtime_role IS NULL THEN
    RAISE EXCEPTION 'serpvera_app must exist before GSC ACL fence';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_class
     WHERE oid IN (
       'public.organizations'::regclass,
       'public.projects'::regclass,
       'public.gsc_connections'::regclass,
       'public.gsc_sync_jobs'::regclass,
       'public.gsc_query_metrics'::regclass
     )
       AND relowner = runtime_role
  ) THEN
    RAISE EXCEPTION 'serpvera_app must not own GSC tables or cascade parents';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = runtime_role) THEN
    RAISE EXCEPTION 'serpvera_app must not be a member of another role during the GSC ACL fence';
  END IF;
END
$preflight$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON public.organizations, public.projects, public.gsc_connections,
     public.gsc_sync_jobs, public.gsc_query_metrics
  FROM PUBLIC, serpvera_app;

DO $column_fence$
DECLARE
  relation_oid REGCLASS;
  column_name TEXT;
BEGIN
  FOR relation_oid IN
    SELECT unnest(ARRAY[
      'public.organizations'::regclass,
      'public.projects'::regclass,
      'public.gsc_connections'::regclass,
      'public.gsc_sync_jobs'::regclass,
      'public.gsc_query_metrics'::regclass
    ])
  LOOP
    FOR column_name IN
      SELECT attname
        FROM pg_attribute
       WHERE attrelid = relation_oid
         AND attnum > 0
         AND NOT attisdropped
    LOOP
      EXECUTE format(
        'REVOKE INSERT (%1$I), UPDATE (%1$I) ON TABLE %2$s FROM PUBLIC, serpvera_app',
        column_name,
        relation_oid
      );
    END LOOP;
  END LOOP;
END
$column_fence$;

DO $verify_fence$
BEGIN
  IF has_table_privilege('serpvera_app', 'public.organizations', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.organizations', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.organizations', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.organizations', 'TRUNCATE')
     OR has_any_column_privilege('serpvera_app', 'public.organizations', 'INSERT')
     OR has_any_column_privilege('serpvera_app', 'public.organizations', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.projects', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.projects', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.projects', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.projects', 'TRUNCATE')
     OR has_any_column_privilege('serpvera_app', 'public.projects', 'INSERT')
     OR has_any_column_privilege('serpvera_app', 'public.projects', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_connections', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.gsc_connections', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_connections', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.gsc_connections', 'TRUNCATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.gsc_sync_jobs', 'TRUNCATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'INSERT')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'UPDATE')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'DELETE')
     OR has_table_privilege('serpvera_app', 'public.gsc_query_metrics', 'TRUNCATE')
     OR has_any_column_privilege('serpvera_app', 'public.gsc_connections', 'INSERT')
     OR has_any_column_privilege('serpvera_app', 'public.gsc_connections', 'UPDATE')
     OR has_any_column_privilege('serpvera_app', 'public.gsc_sync_jobs', 'INSERT')
     OR has_any_column_privilege('serpvera_app', 'public.gsc_sync_jobs', 'UPDATE')
     OR has_any_column_privilege('serpvera_app', 'public.gsc_query_metrics', 'INSERT')
     OR has_any_column_privilege('serpvera_app', 'public.gsc_query_metrics', 'UPDATE') THEN
    RAISE EXCEPTION 'GSC ACL fence could not revoke every effective runtime write privilege';
  END IF;
END
$verify_fence$;

INSERT INTO public.schema_migrations (version, checksum)
VALUES ('0019w_gsc_effective_acl_fence', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
