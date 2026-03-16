---
scope: [scope/backend, scope/services]
files: [src/server/routes/activity.ts, src/server/routes/event-history.ts]
issue: 359
source: spec-review
date: 2026-03-14
---
Spec review caught that M-11 (centralized error handling) didn't address how non-500 route mappings survive the refactor. Routes like `activity.ts` use string-matching on `error.message` to return 404/400/409, and those would break if inline catches were removed without service-layer typed errors. Root cause: the AC said "route handlers throw or re-throw" without analyzing which routes do more than generic 500 handling. Would have been prevented by `/elaborate` grepping for `reply.status(4` across routes to build a complete error-mapping inventory before writing the AC.
