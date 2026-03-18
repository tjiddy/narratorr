---
skill: respond-to-spec-review
issue: 372
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5, F6, F7]
---

### F1: Stats endpoint status keys don't match book schema
**What was caught:** Proposed `snatched` and `downloaded` status keys that don't exist in the book status enum.
**Why I missed it:** Didn't read `src/shared/schemas/book.ts` or `src/client/pages/library/helpers.ts` before writing the stats contract. Used assumed status names instead of checking the actual enum and tab groupings.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "For any new endpoint that aggregates by an existing enum/type, read the source schema and any UI grouping logic before naming response fields."

### F2: Library client-side operations not addressed
**What was caught:** Spec said filters "work correctly" without defining whether search/sort/filter move server-side.
**Why I missed it:** Read `useLibraryFilters` during explore but didn't translate the finding (client-side iteration = broken with pagination) into an explicit AC about where each operation lives.
**Prompt fix:** Add to `/elaborate` step 4: "When adding pagination to a route, check if the frontend processes the full dataset (search, sort, filter, aggregate). If so, add an explicit AC for each operation: does it move server-side or stay client-side on the page slice?"

### F3: Activity queue/history split left ambiguous
**What was caught:** Single paginated endpoint can't drive two client-side sections.
**Why I missed it:** Identified the risk in the elaborate verdict ("ActivityPage splits downloads client-side — needs separate queries or server-side split") but didn't promote it to a concrete AC with a specific contract.
**Prompt fix:** Add to `/elaborate` step 4: "When the elaborate verdict identifies a defect vector, it must either become a concrete AC with a specific contract or an explicit out-of-scope note. 'Needs X or Y' in a verdict is not sufficient — pick one."

### F4: Activity/event-history count contracts unspecified
**What was caught:** Spec said counts should be "computed server-side" without naming fields, endpoints, or how they fit existing contracts.
**Why I missed it:** Didn't check whether `/api/activity/counts` already exists. Assumed counts needed to be invented rather than checking what's already there.
**Prompt fix:** Add to `/elaborate` Explore subagent prompt: "For any proposed new endpoint or response field, check if an existing endpoint already serves the same data. If so, note it and prefer reusing it."

### F5: SSE cache invalidation not addressed
**What was caught:** Changing query keys breaks SSE cache patching.
**Why I missed it:** Identified SSE as a concern during explore but didn't trace the full data flow from SSE event → cache key → setQueryData/invalidation to see the breakage.
**Prompt fix:** Add to `/elaborate` Explore subagent deep source analysis: "When modifying TanStack Query cache keys, trace all paths that call setQueryData or invalidateQueries for those keys — especially SSE/WebSocket handlers."

### F6: Scope contradiction on infinite scroll
**What was caught:** Scope allowed "page controls or infinite scroll" but out-of-scope forbid infinite scroll.
**Why I missed it:** Added the out-of-scope line without re-reading the scope section for contradictions.
**Prompt fix:** Add to `/elaborate` step 4: "After adding scope boundaries, re-read the full Scope section for internal contradictions."

### F7: Blast radius not called out
**What was caught:** Spec didn't enumerate affected frontend/test files.
**Why I missed it:** Elaborate step 3 collects touch points but they stayed ephemeral in the verdict. For large cross-cutting changes, the blast radius should be promoted to the spec body.
**Prompt fix:** Add to `/elaborate` step 4 durable content: "For issues touching 4+ frontend files, add a Blast Radius section listing affected hooks, pages, API clients, and test files."
