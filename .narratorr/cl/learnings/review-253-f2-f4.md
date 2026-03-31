---
scope: [backend]
files: [src/server/routes/books.test.ts, src/server/services/library-scan.service.test.ts, src/server/services/discovery.service.test.ts]
issue: 253
source: review
date: 2026-03-31
---
Reviewer caught that the approved spec's test plan called for caller-surface regressions at all 3 consumer boundaries (manual add, library import, discovery), but implementation only added service-level tests. When a spec test plan explicitly lists caller-surface tests, the implementation must add them — they won't be covered by service-level tests alone. This gap would have been prevented by cross-checking the spec's test plan section against the actual tests written, as a checklist during implementation.
