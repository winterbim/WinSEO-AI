-- ═══════════════════════════════════════════════════════════════
-- WinSEO / SERPVERA — 0002_public_scans.sql
-- Durable public-scan store (Blueprint §8.2 free scan, pre-signup).
--
-- TENANCY NOTE: public scans are ANONYMOUS — there is no organization yet
-- (user has not signed up). Access is gated by an unguessable UUID scan id,
-- NOT by RLS. This is deliberate and documented: a public scan is a public
-- resource, like a rate-limited free endpoint. When the visitor signs up and
-- claims a scan, it is copied into tenant-owned tables (findings/evidence).
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public_scans (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending|running|completed|failed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  findings     JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence     JSONB NOT NULL DEFAULT '[]'::jsonb,
  error        TEXT,
  -- Anti-enumeration: id is a random UUID (gen_random_uuid), never sequential.
  CONSTRAINT public_scans_status_check
    CHECK (status IN ('pending','running','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_public_scans_created ON public_scans(created_at DESC);

-- Runtime role grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'serpvera_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public_scans TO serpvera_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO serpvera_app;
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0002_public_scans', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
