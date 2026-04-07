---
scope: [backend]
files: [src/server/routes/index.ts, src/server/routes/books.ts]
issue: 392
date: 2026-04-07
---
Adding a new optional field to a route deps interface (e.g., `BookRouteDeps.eventBroadcaster`) is only half the work — the wiring site in `routes/index.ts` must also pass the new field. Proxy-based test mocks auto-create all properties, masking the wiring gap in tests. The self-review coverage subagent caught this: existing tests passed because the proxy provided a truthy mock, but the real wiring in `routes/index.ts` didn't pass the field. Always grep for the wiring call site when adding deps.
