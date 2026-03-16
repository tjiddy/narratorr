---
scope: [db]
files: [drizzle/0006_blacklist_reason_not_null.sql, src/db/0006_blacklist_reason_not_null.test.ts]
issue: 365
source: review
date: 2026-03-15
---
Migration SQL files need integration tests when they contain data transformations (backfill, table rebuild). Testing only the post-migration code (routes, services) doesn't prove the migration itself works. A lightweight pattern: create in-memory libSQL client, set up pre-migration schema with stub FK tables, seed test data, run migration statements (split on `--> statement-breakpoint`), assert backfilled values and constraint enforcement.
