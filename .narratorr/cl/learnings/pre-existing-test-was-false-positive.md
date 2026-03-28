---
scope: [backend, services]
files: [src/server/services/library-scan.service.test.ts]
issue: 176
date: 2026-03-28
---
The spec explicitly called out that `library-scan.service.test.ts:1295` ("proceeds with copy when source is inside library root but target path differs") needed to be updated to expect rejection. That test was a documented regression — it existed because the guard didn't exist yet and asserted the wrong behavior. When implementing a guardrail that closes a known gap, check the spec's test plan for explicitly listed tests that must be inverted; don't assume all existing passing tests represent correct behavior.
