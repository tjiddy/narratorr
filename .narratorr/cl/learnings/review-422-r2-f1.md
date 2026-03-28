---
scope: [scope/backend]
files: [src/server/routes/activity.test.ts]
issue: 422
source: review
date: 2026-03-17
---
Reviewer caught missing 500 fallback tests for approve/reject routes after catch blocks were removed in favor of the global error handler plugin. The test gap existed because we verified the typed error paths (404, 409) but didn't verify that untyped errors still produce the generic 500 response through the plugin. When removing route-local error handling in favor of a global plugin, always add a route-level integration test proving the generic fallback still works for that specific route — the plugin's own unit test doesn't prove the route exercises the fallback branch.
