---
skill: respond-to-pr-review
issue: 183
pr: 195
round: 2
date: 2026-03-29
fixed_findings: [F1]
---

### F1: Navigation test uses pattern instead of exact book ID
**What was caught:** `expect.stringMatching(/^\/books\/\d+$/)` would pass even if the wrong book's ID was used.
**Why I missed it:** In round 1 fix, the initial assertion used `/books/1` (wrong — first card by default sort is id=4), then was softened to a regex pattern to fix the test failure rather than computing the correct expected ID.
**Prompt fix:** Add to `/respond-to-pr-review` step 3: "When fixing a test assertion that was too weak, never soften the assertion to make it pass — instead compute the correct expected value from the test data and mock setup. A weakened assertion repeats the original finding."
