---
scope: [scope/db]
files: [drizzle/0007_motionless_vargas.sql]
issue: 366
source: review
date: 2026-03-16
---
Drizzle's generated migration SQL drops ALL indexes then recreates them. When a new table with indexes is added in the same migration, the new indexes get dropped as part of the global "drop all" phase and may not be recreated if they're not in the "recreate all" section at the bottom. Must verify that every CREATE INDEX at the top has a matching CREATE INDEX at the bottom of the migration file.
