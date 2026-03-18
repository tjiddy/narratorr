---
scope: [backend]
files: [src/server/services/discovery.service.test.ts]
issue: 406
date: 2026-03-17
---
Adding a new DB query to refreshSuggestions (dismissal stats) shifted the entire mock chain ordering for all existing refreshSuggestions tests. Each test had to insert a new `mockReturnValueOnce(mockDbChain([]))` as the first db.select call. When modifying a method that has many mock-chain-dependent tests, enumerate ALL test cases that exercise that method and update them systematically — don't just fix the new tests.
