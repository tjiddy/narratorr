---
scope: [backend, services]
files: [src/server/utils/secret-codec.ts, src/server/services/*.test.ts, src/server/__tests__/e2e-helpers.ts]
issue: 315
date: 2026-03-11
---
Adding module-level singleton state (like an encryption key) causes cascading test failures across every service test that touches encrypted fields. Every test file needs `initializeKey()` in beforeEach and `_resetKey()` in afterEach. Budget for updating ALL service test files when adding cross-cutting concerns, not just the ones directly modified.
