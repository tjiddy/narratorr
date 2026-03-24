---
scope: [scope/api, scope/backend]
files: [src/server/routes/blacklist.ts, src/server/routes/blacklist.test.ts]
issue: 271
source: review
date: 2026-03-09
---
Reviewer caught that the new PATCH toggle endpoint had an explicit catch block returning a 500 error payload, but no test forced the service to throw. Route tests covered 200/404/400 but not the 500 path. Every explicit catch block that returns a shaped error response needs a forced-throw test to prove the error contract. This is a recurring pattern — when adding try/catch error handling to routes, always add a corresponding test that rejects the mocked service.
