---
scope: [scope/db]
files: [drizzle/, drizzle/meta/]
issue: 354
source: spec-review
date: 2026-03-14
---
AC said "single migration" which is ambiguous — `drizzle-kit generate` produces both a SQL file in `drizzle/` and bookkeeping updates in `drizzle/meta/`. Fix: for Drizzle schema changes, AC should specify "one new SQL migration in `drizzle/`" and note that `drizzle/meta` updates are expected.
