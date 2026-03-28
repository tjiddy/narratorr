---
skill: respond-to-pr-review
issue: 114
pr: 126
round: 1
date: 2026-03-25
fixed_findings: [F1, F2, F3]
---

### F1: readyCount didn't filter by selected
**What was caught:** `readyCount` counted all high-confidence rows regardless of selection state. Deselecting a book didn't remove it from the ready pill.
**Why I missed it:** The test plan said "Ready count reflects only selected non-duplicate rows" but I wrote no test that exercises deselection after a match result arrives. The computation was consistent with how `reviewCount`/`noMatchCount` work (informational totals), so I didn't notice the asymmetry.
**Prompt fix:** Add to `/implement` step 4a: "For derived count values in hooks, verify each count's filter conditions against the AC contract — specifically whether it should filter by `selected` (import-set counts) or all rows (informational totals). Write a test that exercises the boundary: select → count changes, deselect → count changes."

### F2: No scan reply schema for isDuplicate enforcement
**What was caught:** The scan route lacked a Zod reply schema — `isDuplicate` was TypeScript-only, no runtime enforcement at the HTTP boundary.
**Why I missed it:** I focused on the request schema (forceImport) and the test plan item "Schema validation enforces isDuplicate: boolean" was interpreted as "tests assert the value" rather than "runtime validation at the route level". The existing pattern (request-only schemas) reinforced the oversight.
**Prompt fix:** Add to `/implement` step 4a: "When an AC says 'schema validation enforces X on response items', that requires BOTH a Zod reply schema (parse the response before returning) AND a route test proving malformed data fails. TypeScript types alone do not satisfy runtime schema validation ACs. Add `*Schema` to shared schemas for any new response shape, and `schema.parse(result)` in the route handler."

### F3: Undocumented intent in select-all → forceImport
**What was caught:** Select-all silently opted duplicates into force-import with no test documenting that this is intentional.
**Why I missed it:** The spec says "User can manually check a duplicate row to opt into force-import" — I read this as individual row interaction and wrote tests for that. The "select-all includes duplicates" behavior was addressed in the spec notes (F7 from the spec review) but never turned into a test assertion.
**Prompt fix:** Add to `/implement` step 4a: "For any new behavior with non-obvious side effects (e.g., bulk action triggers a bypass), add a test that names the intent explicitly (test name should start with 'intended behavior' or similar). The reviewer should never have to guess whether a behavior is intentional."
