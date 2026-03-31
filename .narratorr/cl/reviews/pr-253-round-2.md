---
skill: respond-to-pr-review
issue: 253
pr: 256
round: 2
date: 2026-03-31
fixed_findings: [F1]
---

### F1: Predicate assertion under-specified — missing table and correlation checks
**What was caught:** The round-1 fix only checked for `"not exists"` in the SQL tree. The reviewer pointed out this doesn't verify the outer query targets `books`, the subquery targets `bookAuthors`, or that the subquery has a correlation predicate.
**Why I missed it:** I treated the predicate assertion as binary (has notExists or not) instead of verifying the full contract. The mockDbChain proxy exposes `.from()` and `.where()` as separate vi.fn() stubs that can be individually asserted, but I didn't realize I could assert on their arguments.
**Prompt fix:** Add to `/implement` step 4a or a CLAUDE.md gotcha: "When asserting query predicates on mockDbChain, verify all three parts: (1) SQL operator string in the predicate tree, (2) `.from()` called with the correct table reference, (3) subquery `.from()` and `.where()` called with correct table and correlation. A single-dimension check (e.g., only verifying the SQL operator) will be re-raised."
