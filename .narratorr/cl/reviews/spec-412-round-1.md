---
skill: respond-to-spec-review
issue: 412
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4]
---

### F1: AC1 contradicts scope note on porcelain codes and timing
**What was caught:** AC1 said "(UU status)" while the scope note required all unmerged codes, and AC didn't require the check before the stash step.
**Why I missed it:** Wrote AC1 as a natural-language summary rather than a precise contract. The parenthetical was meant as a shorthand example but read as a constraint. Didn't cross-reference AC text against the actual `checkoutOrCreateBranch()` code flow to verify timing requirements.
**Prompt fix:** Add to `/spec` AC writing guidance: "For each AC, verify the text is consistent with scope boundaries. If the scope note adds requirements beyond the AC wording, the AC is underspecified. For code-change ACs, trace the target function's execution order and specify timing constraints explicitly."

### F2: Error propagation contract undefined between helper and CLI
**What was caught:** Spec required "clear error" but didn't define whether the helper throws, the CLI catches, or which layer formats the message.
**Why I missed it:** Focused on the detection logic and didn't think about the error path architecture. The existing code had no catch around `checkoutOrCreateBranch()`, so the gap wasn't obvious from reading just the function.
**Prompt fix:** Add to `/spec` completeness checklist: "When a spec modifies a helper/library function that's called by a CLI script, define the error contract: which layer detects, which layer throws, which layer formats and displays. Check the caller's existing error patterns (e.g., `die(...)`) and specify alignment."

### F3: Test plan referenced out-of-scope code
**What was caught:** Test plan item 9 mentioned `resume.ts` without committing to it in scope or explicitly deferring it.
**Why I missed it:** Included it as a "nice to check" item without realizing it created scope ambiguity.
**Prompt fix:** Add to `/spec` test plan guidance: "Every test plan item must target code within declared scope. References to out-of-scope code belong in the scope boundaries section as explicit follow-ups, not in the test plan."

### F4: Prescriptive commands didn't match broadened detection scope
**What was caught:** AC3 prescribed `git checkout --theirs` but the expanded unmerged states include cases where `--theirs` doesn't apply.
**Why I missed it:** Copied resolution commands from the original issue summary without re-evaluating them against the broadened scope note.
**Prompt fix:** Add to `/spec` AC checklist: "When an AC includes user-facing text/commands, verify the guidance is valid across ALL states the detection logic covers, not just the primary case."
