---
scope: [backend]
files: [src/server/services/library-scan.service.test.ts]
issue: 426
date: 2026-04-08
---
When appending test stubs to the end of a large test file (3500+ lines), verify which `describe()` block they're nested inside. Appending before the final `});` may place stubs inside the wrong describe scope (e.g., a `scanDirectory()` describe instead of the `LibraryScanService` describe that has the mock fixtures in scope). This caused `ReferenceError: mockMetadataService is not defined` — the stubs needed to be inside the describe block with the matching `beforeEach` setup.
