---
scope: [scope/backend]
files: [src/server/routes/auth.ts, src/server/routes/library-scan.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that "At least auth and library-scan use typed error classes" was too coarse -- didn't enumerate which branches (3 in auth, 2 in library-scan) or what HTTP status codes each should preserve. Prevention: when AC references "typed error classes" for specific files, enumerate every string-matching branch with the exact string, line, and expected HTTP status code.
