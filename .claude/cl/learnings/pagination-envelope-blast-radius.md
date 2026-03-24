---
scope: [backend, services, frontend]
files: [src/server/services/*.ts, src/client/lib/api/*.ts, src/client/hooks/*.ts]
issue: 355
date: 2026-03-13
---
Changing a service method's return type from `T[]` to `{ data: T[], total: number }` has massive blast radius. Every caller (internal services, routes, frontend API clients, hooks, test mocks) needs updating. Count callers BEFORE committing to the envelope approach — for #355 this was 30+ files including ~100 test mock sites. Using TanStack Query's `select()` to unwrap at the hook level minimizes component-level changes.
