---
scope: [scope/frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 82
source: review
date: 2026-03-25
---
The reviewer caught that testing a controlled checkbox toggle is incomplete without asserting the post-refetch UI state. When a TanStack Query mutation calls `invalidateQueries` on success, the checkbox re-renders from the new query data — but if the test only asserts the mutation payload and toast, a regression where invalidation or re-render is broken would still pass.

**Why I missed it:** The AC said "fires mutation and reflects new state" but I focused on the mutation-payload side and stopped there. The "reflects new state" half requires updating the mocked query return value and waiting for the checkbox to reflect it.

**What would have prevented it:** Before writing a test for an action that invalidates queries, ask: "What UI state changes after the refetch?" and add a `waitFor` assertion for that state. The test should include a "after refetch" assertion step.
