---
scope: [workflow, testing]
files: [.claude/skills/handoff/SKILL.md, src/client/pages/book/BookLocationSection.test.tsx, src/client/pages/book/BookDetailsContent.test.tsx]
issue: 657
date: 2026-04-20
---
`/handoff`'s coverage gate (step 4) is mechanical: for every non-test, non-config `.ts`/`.tsx` in the diff, it requires a literal co-located `<file>.test.<ext>` sibling. It does NOT count coverage via integration tests in a parent's test file. `BookDetailsContent.tsx` pre-existed without a co-located test (tested only through `BookDetails.test.tsx`) — it slid under the gate because it was unchanged on prior PRs, but any edit to it now triggers the gate. When adding a new co-located component file, plan a sibling `.test.tsx` from the start — don't rely on the parent integration test to count for coverage.
