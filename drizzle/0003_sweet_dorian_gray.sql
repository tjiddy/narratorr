-- #747 — Prevent duplicate active import jobs.
-- Pre-cleanup: among non-null book_id groups, mark older active duplicates as 'failed'
-- so the partial unique index can be created. Orphan rows (book_id IS NULL) are left
-- untouched — SQLite's NULL-uniqueness semantics permit multiple NULL rows alongside
-- the unique index, and orphans are valid (FK-cleared via onDelete: 'set null').
-- Loser policy: keep the most recent active row per book_id (highest created_at,
-- tiebreak by id), flip older losers to status='failed' with an explanatory last_error.
UPDATE import_jobs
SET status = 'failed',
    last_error = 'Superseded by newer active job (dedupe migration #747)',
    updated_at = unixepoch()
WHERE book_id IS NOT NULL
  AND status IN ('pending', 'processing')
  AND id NOT IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY book_id
               ORDER BY created_at DESC, id DESC
             ) AS rn
      FROM import_jobs
      WHERE book_id IS NOT NULL
        AND status IN ('pending', 'processing')
    )
    WHERE rn = 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `idx_import_jobs_book_active` ON `import_jobs` (`book_id`) WHERE status IN ('pending', 'processing');
