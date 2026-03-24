---
scope: [backend]
files: [apps/narratorr/src/server/config.ts, apps/narratorr/src/server/config.test.ts]
issue: 256
date: 2026-03-05
---
`config.ts` runs validation at module scope (not inside a function), so testing requires `vi.resetModules()` + dynamic `import()` for each test case to re-execute the top-level code with different env vars. The `beforeEach` must restore `process.env` to original state AND call `vi.resetModules()` to clear the module cache.
