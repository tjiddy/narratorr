---
scope: [backend]
files: [src/server/__tests__/helpers.ts]
issue: 329
date: 2026-03-10
---
Vitest 4's `Mock` type lives in `@vitest/spy` internally, but you can't import from `@vitest/spy` directly (module not found). Import `Mock` from `vitest` instead: `import { vi, type Mock } from 'vitest'`. When functions return `vi.fn()` results, add explicit `Mock` return type annotations to prevent TS2742 portability errors about inferred types referencing `@vitest/spy`.
