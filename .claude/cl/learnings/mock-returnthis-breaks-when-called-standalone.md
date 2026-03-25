---
scope: [backend]
files: [src/server/services/library-scan.service.test.ts]
issue: 104
date: 2026-03-25
---
`vi.fn().mockReturnThis()` only works correctly when invoked as a method (e.g., `chain.set(...)`). If you capture the mock as `const originalSet = chain.set` and then call `originalSet(...args)` standalone inside a `mockImplementation`, `this` is not the chain — it's `undefined` in strict mode — so the return value breaks the fluent chain and subsequent `.where(...)` calls throw `TypeError: Cannot read properties of undefined`. The fix: either keep a reference to the chain object and return it directly (`return chainMethods`), or avoid intercepting DB chain mocks by triggering failures at a higher level (e.g., `enrichBookFromAudio.mockRejectedValueOnce()` rather than intercepting `.set()`).
