---
scope: [backend, services]
files: [src/server/services/download.service.test.ts]
issue: 57
source: review
date: 2026-03-22
---
When adding a leftJoin projection to multiple service methods, each method needs BOTH a null-case test (deleted FK) AND a positive-case test (existing join row). Testing only the null case proves the null mapping is correct but leaves the non-null branch unexercised — if the join alias or field name regresses, only the positive-case test catches it. Rule: for each new `r.foo?.bar ?? null` mapping, write two tests: one with a real joined row asserting the value, one with null asserting null.
