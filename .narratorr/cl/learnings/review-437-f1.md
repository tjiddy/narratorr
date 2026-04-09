---
scope: [backend]
files: [src/server/services/book.service.test.ts]
issue: 437
source: review
date: 2026-04-09
---
When testing DB update operations via mock chains, asserting `.where` was called is insufficient — must assert the actual predicate argument (e.g., `eq(authors.id, 5)`) to prove the correct row is targeted. Similarly, downstream consumers of the returned ID (like junction inserts) should assert the specific ID value to prove the contract through the call chain. The self-review missed this because it checked invocation counts but not argument values.
