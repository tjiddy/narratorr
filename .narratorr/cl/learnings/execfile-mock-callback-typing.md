---
scope: [core]
files: [src/core/utils/audio-scanner.test.ts]
issue: 434
date: 2026-04-08
---
When mocking `node:child_process.execFile` in Vitest, the overloaded TypeScript signatures make callback parameter typing difficult. Using `(...args: unknown[]) => void` for the callback cast avoids the `@typescript-eslint/no-unsafe-function-type` lint rule while keeping the mock simple. Destructuring `_cmd, _args, _opts, callback` with explicit `Function` type triggers the lint violation.
