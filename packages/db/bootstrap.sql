-- ═══════════════════════════════════════════════════════════════
-- WinSEO / SERPVERA — bootstrap.sql
-- Runs ONCE as a SUPERUSER/admin (e.g. `sudo -u postgres psql -d serpvera_dev`).
-- Creates the separated roles. NO table DDL here (that lives in migrations/).
--
-- ROLE MODEL (SECURITY_MODEL §5, section 7 "bypass/owner problem"):
--   postgres        = migration/admin role. SUPERUSER, BYPASSRLS. Applies DDL only.
--                     NEVER used by the runtime API.
--   serpvera_app    = runtime application role. NOSUPERUSER, NOBYPASSRLS,
--                     NOCREATEDB, NOCREATEROLE. Created NOLOGIN so no password is
--                     ever committed. RLS ALWAYS applies to it.
--
-- Local/CI testing: connect as postgres, then `SET ROLE serpvera_app` inside a
--   transaction. SET ROLE makes the effective role serpvera_app (non-bypass),
--   so RLS filters rows. This proves isolation with no secrets in the repo.
-- Production hardening (out of band, secret from vault, NOT in repo):
--   ALTER ROLE serpvera_app LOGIN PASSWORD '<vault-secret>';
-- The API then connects directly as serpvera_app; the migration/admin role is
--   never used at runtime.
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    CREATE ROLE serpvera_app
      NOLOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT;
  ELSE
    -- Converge existing role to the safe posture
    ALTER ROLE serpvera_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Explicitly assert the runtime role is NOT a superuser and does NOT bypass RLS.
-- If this ever returns anything, the deployment is misconfigured.
DO $$
DECLARE r RECORD;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = 'serpvera_app';
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION 'serpvera_app must not be superuser or bypassrls';
  END IF;
END $$;
