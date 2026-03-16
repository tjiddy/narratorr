---
skill: respond-to-pr-review
issue: 353
pr: 380
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: Missing .gitea/workflows/* in infra trigger list
**What was caught:** CI workflow files weren't included in the trigger patterns for the infra check.
**Why I missed it:** The spec listed concrete trigger files and I transcribed them, but `.gitea/workflows/*` wasn't in the spec's trigger list (it was mentioned in the original debt scan finding W-6 but dropped during spec review when `root/**` was replaced).
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "When the spec mentions CI workflow validation, verify the trigger patterns include the actual CI file paths (e.g., `.gitea/workflows/*`, `.github/workflows/*`)."

### F2: Branch name not passed to downstream skill invocations
**What was caught:** Branch guards verified the branch but didn't pass the name to the downstream skill.
**Why I missed it:** The AC said "each guard includes the current branch name in the skill invocation context" but I implemented only the guard (verify matches pattern) without the context injection (include name in message).
**Prompt fix:** Add to `/implement` step 4a (Red): "When an AC item has two parts (e.g., 'verify X AND include Y'), write test assertions for BOTH parts. If only one part is testable, note the other as a manual check."

### F3: ESLint execution failure treated as zero violations
**What was caught:** `run()` returning `ok: false` with empty stdout was coerced to `[]`, making the lint gate pass.
**Why I missed it:** Focused on the happy path (ESLint produces JSON) and the JSON-parse-failure fallback, but didn't consider the case where ESLint fails before producing any output.
**Prompt fix:** Add to `/plan` step 3 subagent prompt: "For each `run()` or subprocess call, verify the plan handles the case where the command fails AND produces no useful output (empty stdout/stderr)."

### F4: claim.ts control flow not tested
**What was caught:** Tests covered findExistingBranch helper but not the claim.ts checkout/fetch/comment sequence.
**Why I missed it:** Thought testing the helper was sufficient since claim.ts was "just wiring." But the wiring (fetch before checkout for remote, skip checkout main for resume, finalBranch in comment) has its own failure modes.
**Prompt fix:** Add to `/implement` test depth rule: "When extracting a helper for testability, also test the caller's wiring — at minimum verify it calls the helper correctly and uses its output."

### F5: verify.ts lint gate control flow not tested
**What was caught:** Tests covered parseLintJson/diffLintViolations but not the orchestration (fallback on failure, main-branch detection).
**Why I missed it:** Same pattern as F4 — tested the extracted pure functions but not the orchestration.
**Prompt fix:** Same as F4 — this is the same class of gap.
