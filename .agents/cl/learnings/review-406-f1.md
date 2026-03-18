---
scope: [scope/api, scope/backend]
files: [src/server/routes/discover.ts, src/server/routes/discover.test.ts]
issue: 406
source: review
date: 2026-03-17
---
Reviewer caught that switching the manual refresh route to use TaskRegistry changed the response payload from the existing RefreshResult ({added, removed, warnings}) to {ok: true}. The client API still exports the RefreshResult contract. Missed because I focused on the concurrency protection requirement (AC7) and didn't verify that the existing API contract was preserved. Would have been caught by checking the client API type definition before changing the route's return value, or by having the route test assert the response payload shape (not just status code).
