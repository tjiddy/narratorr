---
scope: [scope/backend, scope/db]
files: [drizzle/meta/_journal.json]
issue: 280
source: spec-review
date: 2026-03-10
---
First spec revision mixed `hash` and `idx` fields from two different artifacts (`__drizzle_migrations` table vs `_journal.json`) without verifying field alignment. The DB table has `id, hash, created_at` while the journal has `idx, version, when, tag` — no shared key. The fix was to use row count comparison instead, which works because each migration adds exactly one row to both sides. When designing cross-artifact comparisons, always dump both artifact schemas first and verify the comparison fields actually exist on both sides.
