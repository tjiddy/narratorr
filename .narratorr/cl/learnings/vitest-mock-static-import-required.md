---
scope: [backend]
files: [scripts/lib.test.ts]
issue: 139
date: 2026-03-26
---
When mocking Node built-in modules (`node:child_process`, `node:fs`) with `vi.mock()`, the consuming import MUST be a static top-level `import` statement — NOT a dynamic `await import()` inside a `describe()` block. Top-level `await` in a `describe` body triggers an esbuild transform error: `"await" can only be used inside an "async" function`. Move the `vi.mocked(execFileSync)` reference to module scope using a static import at the top of the file.
