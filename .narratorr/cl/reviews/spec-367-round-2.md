---
skill: respond-to-spec-review
issue: 367
round: 2
date: 2026-03-16
fixed_findings: [F6, F7, F8, F9, F10]
---

### F6: Dependency blocks ready-for-dev label advancement
**What was caught:** Approving the spec would set `status/ready-for-dev` while #366 is still unmerged, making the issue appear claimable.
**Why I missed it:** Focused on the spec body's claiming gate text without considering that the label workflow (`review-spec` → `ready-for-dev`) is what actually controls the claimable pool. The spec said the right thing in prose but the label state would contradict it.
**Prompt fix:** Add to `/respond-to-spec-review` step 9: "If the issue has unmerged blocking dependencies, do NOT advance labels to `review-spec` (which would lead to `ready-for-dev` on approval). Instead, keep the current status and add a note to the spec body: 'Remain at current status until [dep] lands, then re-run /review-spec.'"

### F7: Filtering strategy contradiction across spec sections
**What was caught:** AC 3 said client-side filtering, but the dependency contract, API client, and query keys all encoded server-side filtering via query params.
**Why I missed it:** When round 1 added the Dependency Contract section, I copy-pasted the route definition from #366 (which has `filters: reason, author` on the GET endpoint) without reconciling it with AC 3's "client-side" decision. Each section was internally consistent but they contradicted each other.
**Prompt fix:** Add to `/elaborate` and `/respond-to-spec-review` verification step: "Before writing the updated body, grep the draft for contradictions: if AC says 'client-side filtering', verify no section mentions query params for the same filter. If AC says 'server-side', verify query keys include filter params. Cross-section consistency check is mandatory for filtering, pagination, and caching strategies."

### F8: Dependency contract drifted from #366
**What was caught:** Score range (0-1 vs 0-100) and stats endpoint shape diverged from #366's spec.
**Why I missed it:** The Dependency Contract section was written from memory/inference rather than by reading #366's spec directly. I invented a `libraryBookCount` field that doesn't exist in #366 to solve the empty-state discriminator, and normalized the score range without checking.
**Prompt fix:** Add to `/elaborate` step 3 (Explore subagent prompt): "When the issue has backend dependencies, the subagent MUST read the dependency issue spec (`gitea issue <dep-id>`) and extract the exact field names, value ranges, and response shapes. Return them in a `DEPENDENCY CONTRACT` section. Do NOT paraphrase or normalize values — copy verbatim."

### F9: Settings test blast radius not acknowledged
**What was caught:** Adding a settings category touches shared test files that weren't listed.
**Why I missed it:** The `/elaborate` skill's Fixture Blast Radius check triggers on "settings schema, DB schema, or shared types" but in practice only grepped for DB-related changes. Settings registry changes have the same cascade pattern but the grep wasn't comprehensive enough.
**Prompt fix:** Add to `/elaborate` step 4 Fixture Blast Radius trigger: "Also triggers when the spec adds a new settings category. Grep `registry.test.ts`, `create-mock-settings.test.ts`, and settings page test files for inline fixtures of the settings shape."

### F10: bookStats cache not invalidated
**What was caught:** `useBookStats()` has its own query key and staleTime, so invalidating `books()` alone leaves Library header counts stale.
**Why I missed it:** Round 1's fix for F5 checked the `SearchBookCard.tsx` pattern which invalidates `queryKeys.books()`, but I didn't trace ALL consumers of book-count data. `useBookStats()` is a separate hook with a separate cache entry.
**Prompt fix:** Add to `/elaborate` deep source analysis (step 10): "When adding cache invalidation for a mutation, trace ALL query keys that derive data from the affected entity — not just the primary list query. Check for separate stats/count hooks (e.g., `useBookStats`, `useActivityCounts`) that cache derived data independently."
