---
scope: [scope/db]
files: [src/db/migrate.ts]
issue: 354
source: spec-review
date: 2026-03-14
---
Test plan said "server starts without migration errors" for the idempotence check without specifying how to verify the already-migrated path. Fix: when AC claims idempotence, test plan must include an explicit restart-against-same-DB step to confirm the migration journal prevents re-application.
