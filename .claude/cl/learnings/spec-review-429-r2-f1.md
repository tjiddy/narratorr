---
scope: [scope/backend, scope/db]
files: [src/shared/schemas/notifier.ts, src/shared/notifier-registry.ts]
issue: 429
source: spec-review
date: 2026-03-17
---
The round 1 fix chose `src/shared/notifier-registry.ts` as canonical owner for notification-event artifacts, but missed that `schemas/notifier.ts` already imports `NOTIFIER_REGISTRY` at runtime (line 2, for `superRefine` form validation). Adding the reverse import (registry → schema for event derivation) would create a shared-layer runtime cycle. Would have been caught by: "when proposing a new import edge between two modules, grep both files for existing imports of each other to detect cycle creation."
