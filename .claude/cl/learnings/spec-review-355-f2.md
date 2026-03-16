---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When modifying a shared service method, always check for internal callers beyond the route handler. `BookService.getAll()` was assumed to only back the API route, but search jobs, RSS sync, and rename service all call it and require the full unpaginated dataset. Pagination params must be optional with no default limit at the service level.
