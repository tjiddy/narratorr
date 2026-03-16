---
scope: [scope/backend, scope/services]
files: [src/server/routes/activity.ts]
issue: 356
source: spec-review
date: 2026-03-14
---
Spec review caught that the SQLite chunking requirement only covered the library-scan path but not the activity route's batch `IN(...)` lookup. The elaboration skill treated chunking as a single cross-cutting concern without verifying which specific code paths needed it. When a spec introduces a batching pattern, each new `IN(...)` query site must be individually checked for the >999 parameter limit and covered in the test plan.
