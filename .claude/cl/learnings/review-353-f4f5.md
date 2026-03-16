---
scope: [infra]
files: [scripts/claim.ts, scripts/verify.ts, scripts/lib.ts]
issue: 353
source: review
date: 2026-03-15
---
Testing only the extracted helpers (parseLintJson, findExistingBranch) but not the script-level control flow (claim.ts checkout sequence, verify.ts fallback logic) left the most failure-prone code paths unproven. Fix: extract orchestration logic into testable functions with dependency injection (checkoutOrCreateBranch, runDiffLintGate) so both helpers AND control flow are testable.
