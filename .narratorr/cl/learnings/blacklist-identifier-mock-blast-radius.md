---
scope: [backend, services]
files: [src/server/services/blacklist.service.ts]
issue: 248
date: 2026-03-31
---
Renaming or adding a method to `BlacklistService` has massive test blast radius — `getBlacklistedHashes` was mocked in 7+ test files (monitor, download.service, event-history, retry-search, search route, rss, blacklist.service itself). Adding `getBlacklistedIdentifiers()` required updating every mock that creates a blacklist service stub. The proxy-based `createMockServices()` helper auto-creates stubs but only for route tests; service and job tests build mocks manually.
