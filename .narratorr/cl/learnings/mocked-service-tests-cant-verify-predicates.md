---
scope: [backend]
files: [src/server/services/book.service.test.ts, src/server/__tests__/helpers.ts]
issue: 253
date: 2026-03-31
---
The `mockDbChain()` test harness queues return values without executing or inspecting the Drizzle query predicate. Service-level mocked tests verify branch logic and return contracts, not SQL correctness. For query predicate changes (like adding `notExists`), TDD red/green is awkward — tests pass both before and after implementation because the mock controls the return, not the predicate. The spec review process for #253 explicitly acknowledged this gap: predicate correctness is verified by code review, not unit tests.
