---
skill: respond-to-pr-review
issue: 266
pr: 277
round: 1
date: 2026-04-01
fixed_findings: [F1, F2, F3, F4]
---

### F1: Backend position clauses change no-series ordering for rows with stray seriesPosition
**What was caught:** ORDER BY clauses for seriesPosition fired on all rows, including no-series books with retained seriesPosition from metadata edits.
**Why I missed it:** Didn't consider the interaction where seriesName can be cleared independently of seriesPosition via the metadata modal. The spec only discussed "books with no series" as a uniform group, not as rows with mixed null/populated fields.
**Prompt fix:** Add to `/plan` step 3 explore prompt: "For each new ORDER BY or sort clause, identify all columns it touches and verify they are always populated together. Check whether any column can be independently cleared (metadata edits, partial updates) to create a state where the clause fires unexpectedly."

### F2: Frontend position tiebreaker fires on no-series books
**What was caught:** `compareByField` returns 0 for two null-seriesName books, triggering the position tiebreaker branch that should only apply within named series.
**Why I missed it:** Same root cause as F1 — didn't consider the stray seriesPosition case for null-seriesName books.
**Prompt fix:** Same as F1. Also add to `/implement` step 4: "When adding conditional logic that should only fire within a group, explicitly guard the group membership (e.g., check seriesName != null before comparing seriesPosition)."

### F3: Backend tests only assert argument count
**What was caught:** Tests used `expect(args).toHaveLength(5)` which passes even if clauses are in wrong order or direction.
**Why I missed it:** Followed the existing test pattern (other sort fields only check count). Didn't realize the mock chain captures enough information to assert semantic ordering.
**Prompt fix:** Add to `.claude/docs/testing.md` or CLAUDE.md gotchas: "Drizzle SQL objects expose `queryChunks` with StringChunk objects (`.value` array). Backend ORDER BY tests should assert direction and column references, not just clause count."

### F4: Missing explicit id fallback for equal/null positions
**What was caught:** When two books in the same series have equal positions, `sortBooks` returned 0 (relying on Array.sort stability), not the direction-matched id ordering the backend provides.
**Why I missed it:** The PR body claimed this was covered by "frontend inherits Array.sort stability" but that doesn't match the backend's deterministic contract.
**Prompt fix:** Add to `/implement` step 4: "When the spec says 'fall back to X,' the implementation must explicitly perform that fallback — do not rely on implicit behavior (Array.sort stability, default ordering, etc.)."
