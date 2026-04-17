---
scope: [backend, services]
files: [src/server/services/import-orchestration.helpers.ts, src/server/services/library-scan.service.test.ts]
issue: 635
date: 2026-04-17
---
Migrating `confirmImport` from fire-and-forget background processing to job queue insertion has a large blast radius in the test suite. The library-scan.service.test.ts file had 20+ tests asserting on SSE emissions and background status transitions that all became dead. When changing the execution model of a function (sync vs async, immediate vs queued), grep for ALL test files that call it and audit each assertion — the test count can exceed the production code changes by 3x.
