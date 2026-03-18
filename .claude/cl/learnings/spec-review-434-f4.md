---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec test plan said duplicate grab should "return existing download" but the code throws an error that callers depend on for skip/error classification. When writing test plan bullets for an extraction (not a behavior change), read the current code and write assertions that match current behavior exactly. "Pure extraction" means zero semantic changes.
