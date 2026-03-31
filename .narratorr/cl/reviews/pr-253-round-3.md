---
skill: respond-to-pr-review
issue: 253
pr: 256
round: 3
date: 2026-03-31
fixed_findings: [F1]
---

### F1: Predicate assertion still missing operand-level verification
**What was caught:** Round-2 assertion verified table references and SQL operator text but not the specific column operands — `books.title` in the outer predicate and `bookAuthors.bookId = books.id` in the subquery correlation.
**Why I missed it:** I assumed table-level `.from()` assertions were sufficient to prove column-level correctness. Drizzle column refs carry `.name` and `.table[Symbol.for('drizzle:Name')]` metadata that can be inspected, but I didn't know this until probing the structure in this round.
**Prompt fix:** Add to CLAUDE.md gotchas or `/implement` docs: "Drizzle column references in SQL expressions expose `.name` (column name) and `.table[Symbol.for('drizzle:Name')]` (table name). When asserting query predicates on mockDbChain, use these to verify specific column operands — table-level `.from()` checks alone don't prove column correctness."
