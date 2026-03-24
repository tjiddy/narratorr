---
scope: [scope/services, scope/backend]
files: [src/server/services/book-list.service.ts, src/server/routes/index.ts]
issue: 397
date: 2026-03-16
---
When extracting a service, grep for the class/service name across the entire server directory to find ALL callers — not just the obvious ones. The `startSearchJob` and `startRssJob` functions were missed during the initial wiring pass because they're legacy scheduler entry points that wrap `runSearchJob`/`runRssJob`. TypeScript caught it at typecheck, but this could have been caught earlier with a comprehensive grep.
