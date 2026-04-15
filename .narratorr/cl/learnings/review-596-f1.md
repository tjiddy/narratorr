---
scope: [db]
files: [drizzle/0000_overjoyed_catseye.sql]
issue: 596
source: review
date: 2026-04-15
---
PR body must document runtime verification results, not just file-level checks. For migration flattening, the reviewer expected `SELECT COUNT(*) FROM __drizzle_migrations` output from a fresh DB — citing journal/snapshot files alone doesn't prove the migration applies correctly at runtime. Always run the actual verification step from the issue spec and paste the result.
