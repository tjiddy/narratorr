---
skill: respond-to-pr-review
issue: 372
pr: 396
round: 2
date: 2026-03-16
fixed_findings: [F1]
---

### F1: Full-library duplicate detection still capped at 500 rows
**What was caught:** The round-1 fix of `useLibrary({ limit: 500 })` only moved the truncation ceiling from 100 to 500 — duplicate detection still fails for libraries exceeding 500 books.
**Why I missed it:** I treated the round-1 fix as "good enough" without thinking through what happens at scale. The `paginationParamsSchema` max of 500 felt like a reasonable library size, but that's an assumption about user behavior, not a correct architectural fix.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fixguidance: "When fixing a data-completeness finding, verify the fix works for unbounded data sizes — not just larger bounds. If the fix involves raising a limit, ask: 'what happens when the data exceeds even this new limit?' If the answer is 'same bug,' the fix is a band-aid. Consider a dedicated lightweight endpoint or a fundamentally different approach."
