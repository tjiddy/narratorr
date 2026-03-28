---
skill: respond-to-pr-review
issue: 100
pr: 113
round: 1
date: 2026-03-25
fixed_findings: [F1]
---

### F1: DOM-order tests missing Scan button assertion
**What was caught:** New layout-order tests only asserted the path input's position relative to folder-history headings, not the Scan button's position. The AC specifies "path input + Browse + Scan section" — the Scan button is explicitly part of the moved section.

**Why I missed it:** Wrote tests focused on the most prominent element (the input) and didn't methodically enumerate every element named in the AC. AC said "section" but tests only covered one element within it.

**Prompt fix:** Add to /plan step 5 (test stubs) and /implement step 4a: "For layout-order tests, enumerate every named UI element from the AC and assert each one's position — not just the most prominent element. AC says 'X + Y section' → test both X and Y."
