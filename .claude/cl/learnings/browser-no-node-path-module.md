---
scope: [frontend]
files: [src/client/pages/manual-import/pathUtils.ts]
issue: 134
date: 2026-03-26
---
Browser environments do not have access to `node:path`. When a spec says "use `path.relative()`" for ancestor checks, it is using Node.js API terminology to describe the algorithm, not the literal API. Implement a POSIX-safe utility using segment splitting: `split('/').filter(Boolean)` then compare array prefixes. This avoids both the `node:path` unavailability and the `startsWith()` false-positive (e.g., `/lib` would match `/lib-old` with string prefix comparison but not with segment comparison).
