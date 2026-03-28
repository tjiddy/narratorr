---
skill: respond-to-spec-review
issue: 351
round: 1
date: 2026-03-14
fixed_findings: [F1, F2, F3]
---

### F1: AC7 omits the real count source for the new tabs
**What was caught:** `statusCounts` is built in `useLibraryFilters.ts`, not `StatusPills.tsx`, but the spec only named StatusPills in scope.
**Why I missed it:** Looked at the component that renders counts but didn't trace the prop upstream to its data source. The spec followed the UI tree top-down instead of the data flow bottom-up.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For every prop referenced in AC, trace it to its source — if the source file isn't in scope, flag it. Specifically: for `Record<UnionType, T>` props, find where the record is initialized and verify all union members are accounted for."

### F2: Missing interaction-level flow test for new tabs
**What was caught:** Test plan had helper unit tests and component callback tests but no hook-level test that proves setting the filter actually filters books.
**Why I missed it:** Wrote tests for each layer in isolation (helper, component) but didn't add the integration test that proves they compose correctly. The test plan completeness standard's "end-to-end flows" category was skipped.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "For filter/tab features: always include at least one `useXxxFilters` hook test that sets the new filter value and asserts `filteredBooks` output, per the end-to-end flows requirement."

### F3: Affected test fixtures not enumerated
**What was caught:** Three test files have hardcoded `Record<StatusFilter, number>` fixtures that will break when the type expands.
**Why I missed it:** Didn't grep for all usages of the type being modified to find test fixtures.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "When the issue modifies a shared type/union, grep for all test files that reference it and note which fixtures will need updates."
