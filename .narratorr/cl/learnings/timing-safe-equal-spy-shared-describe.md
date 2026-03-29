---
scope: [backend]
files: [src/server/services/auth.service.test.ts]
issue: 200
date: 2026-03-29
---
The `timingSafeEqual` spy in auth.service.test.ts is shared across all tests in the `session cookie` describe block without per-test reset. When asserting `.not.toHaveBeenCalled()`, you must `mockClear()` the spy first to avoid false positives from prior tests in the same block that legitimately called it.
