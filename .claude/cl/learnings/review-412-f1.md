---
scope: [scope/infra]
files: [scripts/claim.ts, scripts/claim.test.ts]
issue: 412
source: review
date: 2026-03-16
---
Reviewer caught that the claim.ts catch block had no direct test — only the helper (checkoutOrCreateBranch) and the error class were tested, not the script-level formatting and dispatch. The gap was in the test plan: it tested the layer that throws but not the layer that catches and formats. Fix: when adding catch blocks in top-level scripts, always test the script path itself using vi.doMock + dynamic import, not just the helper functions.
