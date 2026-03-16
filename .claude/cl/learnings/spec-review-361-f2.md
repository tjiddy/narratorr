---
scope: [scope/backend, scope/services]
files: [src/server/services/import.service.ts, src/server/jobs/index.ts, src/server/jobs/import.ts]
issue: 361
source: spec-review
date: 2026-03-15
---
Spec review caught that AC4 named `jobs/import.ts` as a production caller, but the actual production scheduler is `jobs/index.ts:33`. `jobs/import.ts` is only consumed by its own test file.

Root cause: `/elaborate` subagent grepped for `ImportService` references and found `jobs/import.ts` but didn't distinguish between production call sites and test-only references. The grep hit `jobs/import.ts` (which exports `startImportJob`) without tracing through to see that the production wiring goes through `jobs/index.ts`.

Prevention: When enumerating callers for a "zero modifications" AC, trace the full call chain to production entry points rather than stopping at the first file that imports the type.
