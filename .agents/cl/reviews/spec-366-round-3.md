---
skill: respond-to-spec-review
issue: 366
round: 3
date: 2026-03-16
fixed_findings: [F10]
---

### F10: Candidate exclusion scope too narrow after imported-only fix
**What was caught:** Round 2 fix for F9 correctly limited signal extraction to `imported` books, but also narrowed candidate exclusion to imported-only. This meant books already tracked as `wanted`/`searching`/`failed` could still be recommended, creating a mismatch with `BookService.findDuplicate()` which checks all statuses.
**Why I missed it:** When fixing F9, I applied "imported-only" as a blanket rule to all books-table queries instead of recognizing that signal extraction and candidate exclusion have different semantic purposes. The quality filter bullet said "against imported books" without checking whether that matched the add-time behavior.
**Prompt fix:** Add to `/respond-to-spec-review` step 5: "When a fix changes a query filter on a table with multiple query purposes (e.g., signal extraction vs candidate exclusion vs add-time dedup), verify the fix applies to the correct query only. Cross-check each query's scope against related operations (especially downstream operations like duplicate detection at add-time) to ensure consistency."
