-- Keep observed page groups with their crawl run for history and review.
-- The JSON contains only route patterns, content-free DOM hashes, counts and
-- up to three sample URLs per group; raw page HTML remains in evidence storage.

BEGIN;

ALTER TABLE crawl_runs
  ADD COLUMN IF NOT EXISTS template_groups JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'crawl_runs_template_groups_array'
       AND conrelid = 'crawl_runs'::regclass
  ) THEN
    ALTER TABLE crawl_runs
      ADD CONSTRAINT crawl_runs_template_groups_array
      CHECK (template_groups IS NULL OR jsonb_typeof(template_groups) = 'array');
  END IF;
END $$;

INSERT INTO schema_migrations (version, checksum)
VALUES ('0028_crawl_template_groups', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
