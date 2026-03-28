---
scope: [scope/frontend]
files: [src/client/components/settings/useFetchCategories.ts, src/client/components/settings/DownloadClientFields.test.tsx]
issue: 147
source: review
date: 2026-03-27
---
The reviewer caught that the non-Error fallback in useFetchCategories ('Failed to fetch categories') had no test. The existing test only covered new Error('Network error'), so the fallback string and the setShowDropdown(false) side effect were unverified for non-Error rejections.

Why we missed it: Same root-cause pattern as F1-F5 from round 1. The TS-1 narrowing change introduced a new non-Error path but the test plan only listed the Error-case test. The round-1 gap was systemic across all narrowing-fix sites, not just the ones the reviewer called out first.

What would have prevented it: When the round-1 retrospective identified "for every ternary fallback add both branches," that rule should have been applied retroactively to ALL narrowing-fix sites in the diff before pushing, not just the 5 the first reviewer called out.
