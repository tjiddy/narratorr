---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/settings/BlacklistSettings.tsx, src/client/pages/settings/BlacklistSettings.test.tsx]
issue: 271
source: review
date: 2026-03-09
---
Reviewer caught that `formatExpiry()` had two independently breakable branches (`Expired` for past timestamps, singular `Expires in 1 day`) that were untested. Existing tests only covered the generic plural `Expires in X days` path. This slipped through because the implementation had obvious render tests but boundary conditions in the formatting function weren't explicitly exercised. When adding display-formatting functions with multiple output branches, each branch needs its own test case with a targeted input value.
