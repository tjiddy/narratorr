---
scope: [backend]
files: [src/server/services/refresh-scan.service.test.ts]
issue: 468
date: 2026-04-11
---
Vitest `rejects.toMatchObject({ code: 'ERROR_CODE' })` replaces the common double-call anti-pattern (rejects.toThrow + try/catch for .code). The double-call pattern exists in at least one other test (rethrows non-ENOENT stat errors at line 329) — future test cleanup should check for this pattern across the test suite.
