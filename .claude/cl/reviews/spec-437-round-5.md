---
skill: respond-to-spec-review
issue: 437
round: 5
date: 2026-03-18
fixed_findings: [F11]
---

### F11: getSeries still required on interface despite no real implementation
**What was caught:** Renaming the null-return from "stub" to "capability gap" didn't change the ISP violation — the method was still required on the interface with no meaningful implementation.
**Why I missed it:** Defended the design by reframing terminology instead of addressing the structural problem. Round 4 response argued it was "correctly placed" when the reviewer's point was that no implementation can fulfill the contract.
**Prompt fix:** Add to /respond-to-spec-review step 5 disposition guidelines: "When a reviewer flags a required interface method that no implementation can fulfill, removing the method from the interface is the correct ISP fix. Do not defend keeping it by reframing the unfulfilled contract — that's changing labels, not fixing the design."
