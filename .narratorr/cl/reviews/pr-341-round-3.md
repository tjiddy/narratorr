---
skill: respond-to-pr-review
issue: 341
pr: 347
round: 3
date: 2026-03-12
fixed_findings: [F20]
---

### F20: Search section missing inline error text for blacklistTtlDays and rssIntervalMinutes
**What was caught:** Only added error message rendering to searchIntervalMinutes when fixing F15 in round 2, but the component has two other validated fields that also need it.
**Why I missed it:** When fixing F15 (search interval validation test), I added the error message rendering for the field the test targeted but didn't audit the rest of the component for the same gap. The test passed because it only checked searchIntervalMinutes.
**Prompt fix:** Add to /respond-to-pr-review: "When adding error rendering or validation display to a component, audit ALL validated fields in that component for the same pattern — not just the one referenced in the finding. The reviewer will check consistency across the whole component."
