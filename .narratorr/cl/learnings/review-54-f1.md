---
scope: [backend, api]
files: [src/server/routes/activity.ts, src/server/routes/activity.test.ts]
issue: 54
source: review
date: 2026-03-21
---
When adding a route with a try/catch that classifies errors into 4xx vs 5xx, only the classified paths (400, 404) got tests — the fallthrough 500 path was missed. Every new catch block that has a distinct response path needs a test that triggers it. The fix: mock the service to reject with an unclassified error and assert statusCode 500 + error body.
