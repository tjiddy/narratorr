---
scope: [backend, services]
files: [src/server/services/library-scan.service.ts, src/server/services/library-scan.service.test.ts]
issue: 176
date: 2026-03-28
---
`copyToLibrary()` is called by both `importSingleBook()` (synchronous, single import) and `processOneImport()` (async, background bulk import). Test stubs for the guard only covered the single-import path initially. A coverage subagent caught the gap — the background path also needed tests verifying that a library-root source causes `status: 'missing'` without triggering `rm`. When adding guards to shared private helpers, enumerate all callers and add tests at each call site's integration layer.
