---
scope: [backend, frontend]
files: [vitest.config.ts, vite.config.ts, tsconfig.json]
issue: 359
date: 2026-03-14
---
When adding path aliases (`@core/`), all three configs must be updated: tsconfig.json (for TypeScript), vite.config.ts (for dev/build), and vitest.config.ts (for tests). Missing the vitest config caused all client tests to fail with unresolved imports. The vitest config has its own `sharedConfig.resolve.alias` that's separate from vite.config.ts.
