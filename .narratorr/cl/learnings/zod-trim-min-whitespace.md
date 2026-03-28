---
scope: [backend]
files: [apps/narratorr/src/shared/schemas/book.ts]
issue: 257
date: 2026-03-05
---
`z.string().min(1)` does NOT reject whitespace-only strings like `'  '`. You need `.trim().min(1)` to catch those. Discovered when a book title validation test sent whitespace and it passed validation. This is a common Zod gotcha — always add `.trim()` before `.min(1)` for user-facing text fields.
