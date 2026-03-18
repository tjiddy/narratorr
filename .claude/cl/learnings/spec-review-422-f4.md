---
scope: [scope/backend, scope/services]
files: []
issue: 422
source: spec-review
date: 2026-03-17
---
Spec asked for typed errors and route updates but didn't state whether routes should keep local catch-block mapping or delegate to the existing global error-handler plugin. Root cause: didn't check the existing error-handler plugin pattern to determine the intended architectural direction. Fix: when introducing typed errors, always state the dispatch pattern (central plugin vs route-local) and reference the existing mechanism.
