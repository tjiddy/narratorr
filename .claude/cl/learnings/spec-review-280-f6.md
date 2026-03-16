---
scope: [scope/backend, scope/db]
files: [src/db/migrate.ts, drizzle/meta/_journal.json]
issue: 280
source: spec-review
date: 2026-03-10
---
Spec said "incompatible schema version aborts restore" without defining what "incompatible" means. The migration system uses Drizzle's auto-migration on startup, which means older backups are fine (they'll be migrated) but newer backups would break. The elaboration step should have read `migrate.ts` and `_journal.json` to define the exact compatibility rule: compare migration idx, reject newer-than-app, allow same-or-older.
