---
scope: [backend]
files: [apps/narratorr/src/server/routes/remote-path-mappings.ts]
issue: 203
date: 2026-02-23
---
The `registerCrudRoutes` helper and `useCrudSettings` hook require `test()` and `testConfig()` methods for connection testing. Entities that don't need test endpoints (like path mappings) should use custom routes and self-contained query/mutation hooks instead. Don't force a pattern that doesn't fit — the abstraction overhead isn't worth it when you'd need to stub test methods that do nothing.
