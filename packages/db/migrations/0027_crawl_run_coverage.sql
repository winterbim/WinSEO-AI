-- Persist the bounded crawl coverage and stop condition so a completed run is
-- never mistaken for a complete inventory of the site.

BEGIN;

ALTER TABLE crawl_runs
  ADD COLUMN IF NOT EXISTS page_limit INTEGER,
  ADD COLUMN IF NOT EXISTS stop_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'crawl_runs_page_limit_range'
       AND conrelid = 'crawl_runs'::regclass
  ) THEN
    ALTER TABLE crawl_runs
      ADD CONSTRAINT crawl_runs_page_limit_range
      CHECK (page_limit IS NULL OR page_limit BETWEEN 1 AND 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'crawl_runs_stop_reason_allowed'
       AND conrelid = 'crawl_runs'::regclass
  ) THEN
    ALTER TABLE crawl_runs
      ADD CONSTRAINT crawl_runs_stop_reason_allowed
      CHECK (
        stop_reason IS NULL OR stop_reason IN (
          'robots_unavailable',
          'robots_blocked',
          'server_throttled',
          'time_budget',
          'page_limit'
        )
      );
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0027_crawl_run_coverage', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
