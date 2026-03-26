---
name: vi-mock-tdc-avoid-imports-in-factory
description: Cannot reference top-level ESM imports inside vi.mock() factory — TDZ (temporal dead zone) error
type: feedback
scope: [frontend, core]
files: [src/client/hooks/useBulkOperation.test.ts]
issue: 135
date: 2026-03-26
---

When using `vi.mock('@/lib/api', () => ({ ... }))` with a sync factory, you CANNOT reference top-level imports inside the factory — this causes `Cannot access '__vi_import_X__' before initialization` (temporal dead zone).

Pattern that fails:
```ts
import { ApiError } from '@/lib/api'; // top-level import
vi.mock('@/lib/api', () => ({
  api: { ... },
  ApiError, // TDZ! vi.mock factory runs before imports are initialized
}));
```

**Fix options:**
1. Duck-type instead of instanceof: `(err as {status?:number})?.status === 404` — no need to import ApiError
2. Define mock class inline in the factory: `ApiError: class ApiError extends Error { constructor(public status: number) { super(); } }`
3. Use `vi.mock` with async factory + `importActual` if you need the real class

**Why:** Vitest hoists `vi.mock()` calls above imports via Babel transform. The factory function runs before top-level imports are initialized, causing TDZ errors when the factory references them.

**How to apply:** If you find yourself needing to reference an imported class inside a `vi.mock()` sync factory, duck-type the error check or define a minimal class inline instead.
