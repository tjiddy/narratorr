---
skill: respond-to-pr-review
issue: 412
pr: 413
round: 1
date: 2026-03-16
fixed_findings: [F1, F2]
---

### F1: claim.ts UnmergedFilesError catch path untested
**What was caught:** The test at claim.test.ts:128-137 only tested the UnmergedFilesError constructor, not the claim.ts catch block that formats and calls die(). Deleting the catch block wouldn't break any test.
**Why I missed it:** Test plan focused on the helper layer (checkoutOrCreateBranch) and the error class shape. Didn't think about testing the script-level integration — the catch block that catches, formats, and dispatches to die(). The "test every layer you changed" rule was violated.
**Prompt fix:** Add to /plan test stub generation: "When a script adds a try/catch around a helper call, create test stubs for both the helper-level behavior AND the script-level catch formatting. Use vi.doMock + dynamic import to test script entry points."

### F2: claim.ts generic-error rethrow branch untested
**What was caught:** The catch block's else branch (non-UnmergedFilesError → rethrow) had no test at the script level. Only the helper-level propagation was tested.
**Why I missed it:** Same root cause as F1 — tested propagation through checkoutOrCreateBranch but not through claim.ts's discriminating catch. Treated the helper test as sufficient for the script behavior.
**Prompt fix:** Add to /plan test stub generation: "For catch blocks with instanceof discrimination, always stub tests for BOTH branches (matched type → handler, unmatched type → rethrow) at the outermost call site."
