---
scope: [backend]
files: [src/server/services/import-orchestration.helper.ts, src/server/services/quality-gate-deferred-cleanup.helper.ts]
issue: 552
date: 2026-04-14
---
When extracting class methods to standalone helper functions, define a `Deps` interface and pass it as a single parameter. The class keeps thin wrapper methods that call the helper with `this.*` deps. For methods that call other class methods staying in the class (like `lookupMetadata`), pass them as callback parameters to avoid circular imports. This pattern follows the existing `enrichment-orchestration.helper.ts` convention.
