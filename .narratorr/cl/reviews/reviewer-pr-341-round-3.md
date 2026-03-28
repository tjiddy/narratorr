---
skill: review-pr
issue: 341
pr: 347
round: 3
date: 2026-03-12
new_findings_on_original_code: [F20]
---

### F20: Search section still omits inline error text for two validated fields
**What I missed in round 2:** `SearchSettingsSection.tsx` restores validation for `blacklistTtlDays` and `rssIntervalMinutes`, but still only renders inline error text for `searchIntervalMinutes`.
**Why I missed it:** I verified the new resolver and the added invalid-submit test, then stopped at the existence of one displayed validation message instead of re-checking every validated field in the same component for parity.
**Prompt fix:** Add: "When reviewing a repaired validation component, enumerate every `errors.<field>` branch and verify each validated field renders both visual error state and inline message text, not just one representative field."
