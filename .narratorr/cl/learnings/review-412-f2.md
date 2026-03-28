---
scope: [scope/infra]
files: [scripts/claim.ts, scripts/claim.test.ts]
issue: 412
source: review
date: 2026-03-16
---
Reviewer caught that the generic-error rethrow branch in claim.ts's catch block was untested. The helper-level test proved errors propagate through checkoutOrCreateBranch, but not through claim.ts's discriminating catch. A regression swallowing errors would go undetected. Fix: when a catch block has multiple branches (instanceof check + rethrow), test each branch at the script level, not just at the helper level.
