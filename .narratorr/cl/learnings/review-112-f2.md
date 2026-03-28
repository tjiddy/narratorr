---
scope: [scope/backend, scope/frontend]
files: [src/server/services/merge.service.ts, src/client/pages/book/useBookActions.ts]
issue: 112
source: review
date: 2026-03-26
---
Post-commit enrichment failure was only logged server-side; the service still emitted merge_complete and returned 200. The user had no way to know enrichment failed — DB audio fields may be stale after a successful merge.

Why we missed it: the enrichment failure path was coded as a warning-level log + continue, not as an observable outcome. The spec said "surface error" but the initial interpretation was "log warning and succeed gracefully" since the merge itself (disk) did succeed. The difference between "disk success" and "full operation success" wasn't surfaced.

What would have prevented it: when a multi-step operation has steps that can partially fail post-commit (i.e. after the irreversible step), explicitly define in the spec and test plan what the user-visible outcome is for each partial failure. A test that asserts the HTTP response body/client toast for "merge succeeded but enrichment failed" would have caught this.
