---
skill: respond-to-pr-review
issue: 364
pr: 376
round: 3
date: 2026-03-14
fixed_findings: [F6]
---

### F6: Missing collision tests for SearchReleasesModal and ImportListsSettings preview
**What was caught:** Duplicate-key collision tests were added for SearchTabContent in round 2 but not for the other two render sites (SearchReleasesModal and ImportListsSettings preview) that also had deduplicateKeys wired in.
**Why I missed it:** When fixing F5 in round 2, I added collision tests to SearchTabContent as the representative example and assumed coverage there proved the pattern worked everywhere. But each render site has its own wiring that could independently regress.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 sibling pattern check: "When a fix involves adding tests for a pattern applied to N sibling render sites/files, verify that EACH site has its own test — not just one representative. List all N files and confirm each has a corresponding test."
