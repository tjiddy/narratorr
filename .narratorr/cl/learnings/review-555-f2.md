---
scope: [backend]
files: [src/server/services/library-scan.service.test.ts, src/server/services/import-orchestration.helper.ts]
issue: 555
source: review
date: 2026-04-14
---
When a helper introduces a new field at call sites (e.g., `snapshotBookForEvent` adds `narratorName` where only `authorName` existed), service-level tests must assert the new field is forwarded. Helper unit tests prove the helper works, but don't prove the call site wires it correctly.
