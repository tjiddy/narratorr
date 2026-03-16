---
scope: [scope/core, scope/backend]
files: [packages/core/src/indexers/torznab.ts, packages/core/src/indexers/newznab.ts, packages/core/src/indexers/abb.ts, apps/narratorr/src/server/services/indexer.service.ts]
issue: 255
source: spec-review
date: 2026-03-03
---
When specifying fail-soft behavior across a two-layer error boundary (adapter catch + service catch), you must pick ONE layer for the error to be handled and make that explicit. Saying "adapter returns empty" AND "service logs warn" is contradictory — if the adapter swallows the error, the service never sees it. The right pattern: new error types (proxy errors) throw from the adapter and are caught at the service layer; existing error types keep their current handling (adapter swallows). Trace the full call chain when specifying error handling.
