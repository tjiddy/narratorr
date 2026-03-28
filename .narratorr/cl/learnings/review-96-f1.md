---
scope: [scope/backend]
files: [src/server/services/import.service.test.ts]
issue: 96
source: review
date: 2026-03-26
---
The reviewer caught that the shared mega-`beforeEach` at the parent `describe('ImportService')` level was preserved after the refactor. The refactor moved describe nesting and consolidated suites correctly, but missed that the AC "each describe block has its own focused beforeEach setup" requires removing the parent-level shared setup — not just adding nested setup on top of it.

Why we missed it: Existing nested describes (`upgrade flow`, `remote path mapping`) already had their own `beforeEach` blocks overriding specific mocks. The refactor treated those as "focused setup" and assumed the parent `beforeEach` was an acceptable shared baseline. The AC said "no shared mega-setup" which directly disqualifies any parent-level `beforeEach` that initializes the full dependency graph.

What would have prevented it: During implementation, explicitly verify that the parent `ImportService` describe block has NO `beforeEach` after the refactor. The AC is not "each describe has ADDITIONAL focused setup" — it is "each describe OWNS its setup with no shared parent". Fix: convert the parent `beforeEach` to a named helper `setupDefaults()` and call it from each concern's own `beforeEach`.
