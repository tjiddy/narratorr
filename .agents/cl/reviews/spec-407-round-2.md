---
skill: respond-to-spec-review
issue: 407
round: 2
date: 2026-03-17
fixed_findings: [F5, F6]
---

### F5: Frontend scope contradiction
**What was caught:** Scope Boundaries said "Frontend changes" out of scope while Enum Touch List, Client Type Sync, and Route & Filter Surface sections all required client file edits.
**Why I missed it:** The scope boundaries were written first, then the Enum Touch List was added in round 1 fixes without re-checking whether the new in-scope work contradicted the existing out-of-scope bullets.
**Prompt fix:** Add to /spec scope boundaries checklist: "After adding cross-cutting changes (enum extensions, type additions), grep all mentioned file paths against scope boundaries to verify no in-scope file appears in the out-of-scope section."

### F6: Phantom method name in test plan
**What was caught:** Test plan referenced `computeResurfacedScore()` which doesn't exist — actual path is `resurfaceSnoozedRows()` -> `getStrengthForReason()` + `scoreCandidate()`.
**Why I missed it:** Named the method from conceptual intent rather than verifying against the codebase. The test plan was written speculatively without a grep to confirm the artifact exists.
**Prompt fix:** Add to /spec test plan checklist: "Every method/function/class name referenced in a test case MUST be verified with `rg <name> src/` before submission. If the symbol doesn't exist, describe the observable behavior instead of naming a phantom artifact."
