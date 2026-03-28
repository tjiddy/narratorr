---
scope: [backend]
files: [src/server/__tests__/helpers.ts]
issue: 393
date: 2026-03-15
---
Proxy-based mocks need a `set` trap when existing tests assign to the object's properties. The import.service.test.ts manually assigns `downloadsUpdateChain.set = vi.fn().mockImplementation(...)` — without a set trap, the Proxy silently ignores the assignment and the test fails because the original stub is returned instead of the override. Always add a set trap when replacing plain objects with Proxies in shared test infrastructure.
