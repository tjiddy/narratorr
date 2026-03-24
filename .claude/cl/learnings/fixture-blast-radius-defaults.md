---
scope: [backend, services]
files: [src/server/__tests__/factories.ts, src/server/services/recycling-bin.service.test.ts]
issue: 71
date: 2026-03-24
---
Test factories with default values for fields like `narrator: 'Michael Kramer'` cause unexpected restore processing in tests that don't intend to test narrator behavior. When you change a factory default (e.g., from `narrator: string` to `narrators: []`), read every test using that factory and check whether its assertions still make sense. A test that previously passed with `insertTimes(2)` may need `insertTimes(3)` if a narrator field exists in the default.
