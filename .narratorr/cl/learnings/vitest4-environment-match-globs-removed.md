---
scope: [infra]
files: [vitest.config.ts]
issue: 329
date: 2026-03-10
---
Vitest 4 removed `environmentMatchGlobs` — use `test.projects` instead. Each project gets its own `environment`, `include` globs, and `setupFiles`. The `sharedConfig` pattern (extract resolve/alias to a const, spread into each project) keeps the DRY. Environment shows as `0ms` when not applied — if all client tests fail with "document is not defined", check that the environment config is actually being read.
