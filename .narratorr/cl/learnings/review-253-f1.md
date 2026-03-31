---
scope: [backend]
files: [src/server/services/book.service.test.ts]
issue: 253
source: review
date: 2026-03-31
---
Reviewer caught that mocked service tests only verify branch plumbing, not query predicate contracts. When adding a new query filter (like `notExists`), the test must assert the predicate shape — not just that the mock chain was called N times. The fix: capture the chain returned by `db.select()`, then inspect `.where()` mock arguments for the expected SQL expression. This gap would have been prevented by a /plan rule: "When modifying query predicates, add a predicate-contract assertion on the `.where()` mock arguments."
