---
scope: [backend]
files: [src/server/services/import.service.ts]
issue: 361
date: 2026-03-16
---
With `@typescript-eslint/return-await` set to `'in-try-catch'`, `return await` is required inside `try` blocks but NOT inside `catch` blocks. When a catch block calls a function returning `Promise<never>` (always throws), use bare `return handleImportFailure(...)` without `await` — this satisfies both the TS control flow (function has return statement) and the lint rule (no `return await` outside try block). The `return` lets TS see the catch always ends, while the missing `await` satisfies the linter.
