---
scope: [backend, core]
files: [src/core/metadata/errors.ts]
issue: 366
date: 2026-03-16
---
`RateLimitError` constructor takes `(retryAfterMs: number, provider: string)` — not `(provider, retryAfterMs)`. This caused a typecheck failure because JS doesn't error on wrong-order args when types differ. Always check constructor parameter order before writing test mocks — `grep 'constructor(' src/core/metadata/errors.ts` is faster than a typecheck round-trip.
