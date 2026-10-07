-- Correct the database-visible description without rewriting migration 0028.

BEGIN;

COMMENT ON COLUMN crawl_runs.template_groups IS
  'Observed structure groups only: redacted sample URLs, counts, URL patterns, and content-free DOM hashes. Page bodies are not stored here.';

INSERT INTO schema_migrations (version, checksum)
VALUES ('0029_crawl_template_groups_comment', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;

COMMIT;
