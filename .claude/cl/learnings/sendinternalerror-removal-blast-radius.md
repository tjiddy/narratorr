---
scope: [scope/backend]
files: [src/server/routes/auth.test.ts, src/server/routes/discover.test.ts]
issue: 448
date: 2026-03-18
---
Removing route-local try/catch blocks that call sendInternalError has two hidden blast radius items: (1) route tests that create their own Fastify app (like auth.test.ts) need the errorHandlerPlugin registered since errors now propagate to it; (2) route tests with partial mock data (like discover.test.ts) need full Date objects for timestamp fields since the toSuggestionResponse mapper calls .toISOString() on them. Both are silent failures (500s instead of expected status codes) that only surface at test runtime.
