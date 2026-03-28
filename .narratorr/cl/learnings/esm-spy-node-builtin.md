---
scope: [backend]
files: [src/server/services/auth.service.test.ts]
issue: 82
date: 2026-03-25
---
`vi.spyOn(module, 'fn')` cannot spy on named exports from ESM built-in modules like `node:crypto` — the namespace is non-configurable and throws "Cannot redefine property". The fix is `vi.mock('node:crypto', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, fn: vi.fn(actual.fn) }; })` at the module level, then import the named export at the top of the file — it resolves to the spy. Avoid `typeof import('node:crypto')` as a generic type in `importOriginal<T>()` — the `consistent-type-imports` rule forbids inline `import()` type annotations; cast the result instead (e.g. `actual as Record<string,unknown> & { fn: typeof fn }`).
