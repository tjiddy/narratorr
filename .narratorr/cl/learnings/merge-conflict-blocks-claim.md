---
scope: [scope/infra]
files: [scripts/claim.ts]
issue: 352
date: 2026-03-14
---
Pre-existing merge conflicts (UU files from stash conflicts) block `scripts/claim.ts` because it runs `git checkout main` which fails with "you need to resolve your current index first." Must resolve all UU files before claiming any issue. This is a known debt item but still causes friction — claim.ts could detect and warn about unmerged files before attempting checkout.
