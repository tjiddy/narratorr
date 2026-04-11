---
scope: [backend, frontend, core]
files: []
date: 2026-04-10
---
Regex with the global flag (`/pattern/g`) is stateful — `.test()` and `.exec()` advance `.lastIndex` after each match. If the same regex instance is reused across calls (module-level `const REGEX = /foo/g`), the second call starts matching from where the first left off, producing wrong results. Fix: reset `REGEX.lastIndex = 0` before each use, or don't use the `g` flag when only testing for presence.
