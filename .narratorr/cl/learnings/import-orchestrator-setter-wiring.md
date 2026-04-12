---
scope: [backend]
files: [src/server/services/import-orchestrator.ts, src/server/routes/index.ts]
issue: 504
date: 2026-04-12
---
When adding dependencies to services created before `retrySearchDeps` in routes/index.ts, use the setter pattern (`setBlacklistDeps`) not constructor expansion. The mock in routes/index.test.ts must also include the setter — `vi.fn()` alone won't work; use `vi.fn().mockImplementation(function(this) { this.setBlacklistDeps = vi.fn(); })`.
