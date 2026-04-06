---
scope: [backend]
files: [src/server/services/indexer.service.ts, src/server/services/indexer.service.test.ts]
issue: 372
source: review
date: 2026-04-06
---
Reviewer caught that testConfig() warning passthrough was untested even though test() passthrough was covered. When widening return types on multiple service methods (test + testConfig), test both — they may share code but have different entry paths.
