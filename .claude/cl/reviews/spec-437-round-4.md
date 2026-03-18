---
skill: respond-to-spec-review
issue: 437
round: 4
date: 2026-03-18
fixed_findings: [F10]
---

### F10: getSeries stub claim overstated
**What was caught:** Spec claimed the ISP split "eliminates all stub implementations" but AudibleProvider.getSeries() still returns null.
**Why I missed it:** Used absolute language without verifying every method on each interface. Didn't distinguish between cross-provider stubs (ISP problem) and within-provider capability gaps (API limitation).
**Prompt fix:** Add to /elaborate step 3 deep source analysis: "When claiming a refactor removes stubs, verify each method on each resulting interface has a real implementation. Distinguish cross-provider stubs (ISP violation — method on wrong interface) from capability gaps (method correctly assigned but underlying API doesn't support it). Use precise language: 'eliminates cross-provider stubs' not 'eliminates all stubs'."
