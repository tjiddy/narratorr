---
skill: respond-to-spec-review
issue: 360
round: 2
date: 2026-03-14
fixed_findings: [F6]
---

### F6: Deep-merge test plan still uses nonexistent search fields
**What was caught:** Test plan referenced `search.maxResults` and `search.includeAdult`, which don't exist in `searchSettingsSchema` (real fields: `intervalMinutes`, `enabled`, `blacklistTtlDays`).
**Why I missed it:** When fixing F5 (nested quality shape) in round 1, I only fixed the quality example and didn't verify the search example against the actual schema. Both examples shared the same root cause — writing test scenarios with assumed field names — but I only fixed one of them.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (verify fixes): "When fixing a finding about schema/type mismatches, grep for ALL field names used in the test plan section and verify each one against the actual schema definition. Don't fix one example and leave adjacent examples with the same class of error."
