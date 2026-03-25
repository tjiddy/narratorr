---
scope: [scope/frontend]
files: [src/client/pages/manual-import/useFolderHistory.ts]
issue: 81
source: review
date: 2026-03-25
---
`demoteToRecent()` enforced the cap in `addRecent()` but forgot the same cap enforcement in its own non-collision branch. The `.slice(0, MAX_RECENTS)` was only applied in `addRecent`, not in `demoteToRecent`.

Why missed: Cap enforcement was implemented correctly in `addRecent` but not systematically applied to all paths that grow the recents array. Demotion is a less-obvious growth path than explicit `addRecent` calls.

What would have prevented it: A sibling-pattern check: after writing `addRecent`'s cap logic, grep for all other places that call `sortByRecency([...prevRecents])` and verify each one also slices. The test plan specified "cap applies on demotion" but no red/green test was written for it before implementation.
