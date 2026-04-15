---
scope: [backend]
files: [src/server/routes/search-stream.test.ts]
issue: 563
source: review
date: 2026-04-15
---
When refactoring from module-scope `vi.mock` to per-test `vi.spyOn`, the structural change alone doesn't prove coexistence works. Must include at least one test that deliberately does NOT install the spy and exercises the real function, verifying the output shape matches the production contract.
