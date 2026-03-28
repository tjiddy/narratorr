---
scope: [scope/backend, scope/services]
files: []
issue: 422
source: spec-review
date: 2026-03-17
---
Spec didn't list which test files would be affected by the typed-error refactor, making it hard to scope the work. Root cause: test plan focused on what to test but not where the tests live. Fix: for refactors that change error contracts, list the affected test files explicitly so the blast radius is visible upfront.
