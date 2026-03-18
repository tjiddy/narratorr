---
skill: respond-to-pr-review
issue: 430
pr: 446
round: 1
date: 2026-03-18
fixed_findings: [F1]
---

### F1: Missing active-styling regression test for SettingsLayout
**What was caught:** The registry-derived active-nav branch (isActive conditional) had no test. Only href values were asserted.
**Why I missed it:** The existing tests checked link targets and navigation clicks, which felt like sufficient coverage. The active-styling branch was treated as "visual implementation" rather than "testable behavior." The coverage review subagent flagged pre-existing untested behaviors in jobs but missed this new branch.
**Prompt fix:** Add to /handoff step 4 coverage review prompt: "For components that compute visual state from data (active class, disabled state, visibility), verify the visual state assertion exists — not just the data source assertion. href tests don't prove active-styling works."
