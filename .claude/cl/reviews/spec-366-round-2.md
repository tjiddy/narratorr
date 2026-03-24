---
skill: respond-to-spec-review
issue: 366
round: 2
date: 2026-03-16
fixed_findings: [F8, F9]
---

### F8: Contradictory metadata query paths
**What was caught:** Round 1 fixes introduced three incompatible query surfaces for discovery (search(), searchBooks(options), getAuthorBooks()) that couldn't be composed into one implementation.
**Why I missed it:** Each round 1 fix (F2→options, F3→warnings) was correct independently but I didn't re-read the combined spec to check for internal consistency. The candidate generation section referenced searchBooks(options), the rate limit section referenced search(), and the service section mixed both.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification: "After applying all fixes, re-read AC + Implementation sections together and verify there is exactly one named method/surface for each operation. If multiple findings touch the same subsystem (e.g., metadata querying), design one unified fix rather than independent patches."

### F9: Library scope undefined for signal extraction
**What was caught:** Spec said "user's library" but books table has 7 status values — unclear which feed analysis.
**Why I missed it:** The elaborate step focused on which fields exist on books (genres, series, narrator) but not which rows qualify as "library." The status column was visible in the schema but I treated all rows as implicitly relevant.
**Prompt fix:** Add to `/elaborate` step 3 subagent deep source analysis: "For every query the spec will perform against a table with a status/lifecycle column, verify the spec defines which status values are included. If the spec says 'all books' or 'the library' without a status filter, flag as an ambiguity that needs resolution."
