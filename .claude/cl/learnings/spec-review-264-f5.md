---
scope: [scope/backend, scope/frontend, scope/core]
files: [src/shared/indexer-registry.ts, src/client/components/settings/IndexerFields.tsx, src/client/lib/api/indexers.ts, src/db/schema.ts, src/shared/schemas/indexer.ts, src/core/indexers/registry.ts]
issue: 264
source: spec-review
date: 2026-03-08
---
AC7 listed only "DB schema, Zod schemas, and indexer service adapter factory" as wiring points, but adding an indexer type also requires: shared indexer registry metadata, frontend field component, client API type union, core adapter factory, and index export. Under-specified wiring ACs leave compile/test failures at implementation time. Always enumerate all registration points when adding a new variant to an enum/union.
