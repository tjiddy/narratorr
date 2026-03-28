---
scope: [scope/backend]
files: [src/server/routes/auth.test.ts, src/server/routes/library-scan.test.ts]
issue: 431
date: 2026-03-17
---
When converting from string-based error matching (error.message === 'X') to typed error classes (instanceof), all test mocks that throw plain Error('X') must be updated to throw the typed class. If the route catches by instanceof and the mock throws plain Error, the catch doesn't match and falls through to 500. This is the #1 blast radius of typed error migrations — grep test files for the old error strings before committing.
