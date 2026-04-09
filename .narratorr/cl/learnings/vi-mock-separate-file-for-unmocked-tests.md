---
scope: [backend]
files: [src/server/routes/search-stream.test.ts, src/server/routes/search-stream-filtering.test.ts]
issue: 438
date: 2026-04-09
---
When a test file has a module-level `vi.mock()` that replaces a dependency, you cannot unmock it for a subset of tests in the same file — `vi.mock` hoists above all imports and affects the entire module. The clean solution is a separate test file without the mock. `vi.doUnmock()` + dynamic `import()` inside describe blocks is theoretically possible but fragile with Vitest's module cache. Separate files are simpler and more maintainable.
