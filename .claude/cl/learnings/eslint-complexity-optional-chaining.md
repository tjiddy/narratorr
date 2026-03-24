---
scope: [backend, services]
files: [src/server/services/import.service.ts]
issue: 361
date: 2026-03-16
---
ESLint `complexity` rule counts `??` (nullish coalescing) as a decision point but NOT `?.` (optional chaining). When refactoring to reduce complexity, hoisting `author?.name ?? null` to a single variable at the top of the method eliminates repeated `??` operators that each contribute +1 complexity. Also, `try/catch` blocks contribute +1 per `catch` — extracting SSE emission into a helper function removes that complexity from the parent method.
