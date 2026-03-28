---
scope: [backend]
files: [apps/narratorr/src/server/routes/activity.test.ts, apps/narratorr/src/server/routes/metadata.test.ts, apps/narratorr/src/server/routes/settings.test.ts]
issue: 216
date: 2026-02-24
---
Error-path tests that only assert `statusCode === 500` are weak — they pass whether the route's catch block or Fastify's default error handler runs. Always add `expect(JSON.parse(res.payload).error).toBe('Internal server error')` to prove the route's own catch block executed. This is the standard pattern going forward for all route error tests.
