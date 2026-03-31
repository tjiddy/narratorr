---
scope: [backend]
files: [src/server/services/book.service.test.ts]
issue: 253
source: review
date: 2026-03-31
---
Reviewer re-raised F1: a generic "not exists" tree search was insufficient — the assertion must also verify which tables the outer and subquery target. The fix: assert `.from()` was called with the correct table references (`books` for outer, `bookAuthors` for subquery) and that the subquery `.where()` was called (proving correlation). When writing predicate-contract assertions on mockDbChain, check all three parts: (1) SQL operator text, (2) outer table reference, (3) subquery table + correlation.
