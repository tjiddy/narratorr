---
scope: [backend]
files: [src/server/jobs/monitor.test.ts]
issue: 270
date: 2026-03-08
---
ESLint's `@typescript-eslint/consistent-type-imports` rule forbids inline `import()` type annotations like `import('../foo.js').Bar`. Instead, add a top-level `import type { Bar } from '../foo.js'` and use `Bar` directly. This avoids the lint error without needing `typeof import(...)` workarounds.
