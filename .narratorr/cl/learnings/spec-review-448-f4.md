---
scope: [scope/backend]
files: [src/server/utils/route-helpers.ts, src/server/plugins/error-handler.ts]
issue: 448
source: spec-review
date: 2026-03-18
---
Spec sendInternalError migration plan only addressed response shape ({ error: string } preserved) but did not address the route-local logging that current catch blocks provide. Each catch block logs context like "Failed to fetch activity" before calling sendInternalError. Removing the catch blocks means the global error handler logs error.message instead -- different diagnostic content.

Root cause: The blast radius analysis counted call sites and response shapes but did not audit what else the catch blocks do besides return the error. Catch blocks often have side effects (logging context, cleanup, metrics) that are lost when removed.

Prevention: When analyzing catch-block removal, audit each catch block for non-response side effects (logging context, cleanup, metrics, state changes) and document whether they must be preserved, migrated, or are intentionally dropped.
