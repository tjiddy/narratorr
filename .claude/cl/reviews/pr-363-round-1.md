---
skill: respond-to-pr-review
issue: 363
pr: 394
round: 1
date: 2026-03-15
fixed_findings: [F1, F2]
---

### F1: SearchResults tab tests missing Authors panel linkage and Left/wraparound paths
**What was caught:** Tests only covered ArrowRight from Books→Authors but never verified the tabpanel `aria-labelledby` changed, never tested ArrowLeft, and never tested wraparound in both directions.
**Why I missed it:** The test stubs from `/plan` mapped 1:1 with spec interactions but didn't enumerate all keyboard paths — the spec said "arrow key navigation works" and I wrote one ArrowRight test to cover it. Didn't think of tab panel linkage as a separate assertion from aria-selected.
**Prompt fix:** Add to `/plan` step 5 test stub generation: "For keyboard navigation AC items, generate one stub per direction AND one for wraparound. For ARIA linkage AC items (aria-labelledby, aria-controls), generate stubs that assert the linkage updates on state change — not just initial state."

### F2: BookDetails tab tests missing tabpanel linkage assertion on switch and non-empty id check
**What was caught:** Tests verified aria-selected and focus changes but never checked that the tabpanel's `aria-labelledby` actually changed when switching tabs. Tab button ids were never asserted as non-empty.
**Why I missed it:** Same root cause as F1 — treated `aria-selected` as sufficient proof of tab switching without realizing the panel linkage is a separate testable contract. The id assertion gap was because I assumed the presence of `aria-labelledby` implicitly proved ids existed.
**Prompt fix:** Add to `/implement` step 4a test depth rule: "When testing ARIA attributes that cross-reference other elements via id (aria-labelledby, aria-controls, aria-describedby), always assert: (1) referenced ids are non-empty, (2) linkage updates when the active element changes."
