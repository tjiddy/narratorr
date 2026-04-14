---
scope: [backend]
files: [src/server/services/auth.service.test.ts]
issue: 545
date: 2026-04-14
---
When writing "same length, different value" test cases, count the characters of both strings. `'test-key-123'` (12 chars) vs `'wrong-key-xxx'` (13 chars) are NOT the same length — this caused a false test failure that looked like a production bug. Always verify length equality explicitly before trusting a "same length" test fixture.
