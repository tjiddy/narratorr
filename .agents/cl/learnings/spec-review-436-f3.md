---
scope: [scope/backend, scope/services]
files: []
issue: 436
source: spec-review
date: 2026-03-17
---
Reviewer caught that the failure contract was inconsistent — "error at any step → handleImportFailure" vs individual side effects being isolated/best-effort. The existing code already has a split contract (enrichment=fatal, tagging=best-effort, notifications=fire-and-forget) but the spec flattened it into one vague statement. Root cause: didn't audit the existing error handling behavior per side effect before writing the spec. Fix: for extraction specs, include an explicit side-effect classification table (fatal/best-effort/fire-and-forget) with rationale derived from current code behavior.