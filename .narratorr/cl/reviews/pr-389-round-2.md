---
skill: respond-to-pr-review
issue: 389
pr: 391
round: 2
date: 2026-03-15
fixed_findings: [F8]
---

### F8: Activity-page delete entry point presence-only test
**What was caught:** The activity page's delete button wiring only had a presence assertion, not an interaction test proving `deleteMutation.mutate(id)` receives the correct event id.
**Why I missed it:** When fixing F5 in round 1, I added the interaction test for BookEventHistory but didn't apply the sibling pattern check to EventHistorySection's analogous test. The existing presence test masked the gap.
**Prompt fix:** Add to /respond-to-pr-review step 3 sibling pattern check: "When upgrading a test from presence-only to interaction, grep for the same presence-only pattern in sibling page/component test files and upgrade all instances — not just the one the reviewer flagged."
