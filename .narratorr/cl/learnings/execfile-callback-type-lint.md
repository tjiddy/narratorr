---
scope: [backend]
files: [src/server/utils/post-processing-script.test.ts]
issue: 198
date: 2026-03-12
---
When mocking `execFile` with a callback pattern, casting the callback `as Function` triggers `@typescript-eslint/no-unsafe-function-type`. Use `as (...args: unknown[]) => void` instead. This is easy to miss because `as Function` is the natural first instinct for untyped callback mocks.
