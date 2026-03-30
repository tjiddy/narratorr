---
skill: respond-to-pr-review
issue: 216
pr: 221
round: 2
date: 2026-03-30
fixed_findings: [F1]
---

### F1: ABS library select onChange propagation untested
**What was caught:** The ABS library select test rendered the select and verified options but never selected an option to prove the onChange handler works.
**Why I missed it:** When writing the round 1 fix for F2, I focused on proving the select branch renders (contract test) but treated the interaction as implicitly covered because the component uses a standard onChange. I stopped at "renders correctly" when I should have also tested "behaves correctly."
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fix completeness: "For conditional rendering branches (e.g., element appears after data fetch), verify the test includes both (a) render assertion and (b) interaction assertion proving the new branch's event handler works — rendering is necessary but not sufficient."
