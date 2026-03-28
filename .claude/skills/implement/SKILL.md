---
name: implement
description: Full lifecycle implementation of a GitHub issue — claims, plans, implements,
  and hands off with a PR. Use when user says "implement issue", "build this", or
  invokes /implement.
argument-hint: <issue-id>
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node scripts/hooks/stop-gate.ts implement"
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/workflow.md`

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

# /implement <id> — Full lifecycle: claim → plan → implement → handoff

End-to-end orchestrator skill. Claims the issue, plans the implementation, builds it, and hands off with a PR.

## GitHub CLI

All GitHub commands use: `node scripts/gh.ts` (referred to as `gh` below).

## Steps

### Phase 0 — Initialize state tracking

0. **Initialize stop-gate state:** `mkdir -p .narratorr/state/implement-<id>/`
   - This directory tracks phase completion for the stop hook. The hook will block premature stops until all phases are marked complete.

### Phase 1 — Claim

1. **Claim the issue** by running: `node scripts/claim.ts <id>`
   - If output starts with `ERROR:` → write `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/stopped` then STOP. Do not continue.
   - If output starts with `CLAIMED:` → write phase marker: `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/claim-complete` and continue to Phase 2.

### Phase 2 — Plan

1b. **Branch guard:** Run `git branch --show-current` and verify the output matches `feature/issue-<id>-*`. If not, STOP: "Branch mismatch before /plan — expected feature/issue-<id>-*, got <actual>." Save the branch name for use in downstream invocations.

2. **Invoke `/plan <id>`** via the Skill tool. Include in your message to the Skill tool: "Current branch: `<branch-name-from-step-1b>`" so the downstream skill can verify it is operating on the correct branch.
   - `/plan` explores the codebase, extracts test stubs from the spec, and posts a structured implementation plan on the issue.
   - The plan comment and test stubs feed directly into the implementation phase.
   - When `/plan` returns → write phase marker: `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/plan-complete` and continue to Phase 3.

### Phase 3 — Implement

3. **Read the issue spec one final time** — it may have been updated during elaboration:
   - `node scripts/gh.tsissue view $ARGUMENTS --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'`

4. **Implement the feature/fix using red/green TDD:**

   Work through the plan one module at a time (e.g., service, route, component). For each module:

   **a. Red — write failing tests first.**
   Convert the `it.todo()` stubs from `/plan` into real test implementations. Write the full test body (assertions, mocks, setup) against the spec requirements — not against any implementation that exists yet. Run `pnpm exec vitest run <test-file> --no-color` and **confirm the tests fail**. If a test passes before implementation exists, it's vacuous — fix the assertion so it actually tests the spec behavior.

   **Test depth rule:** For each AC item with testable behavior (validation, error handling, state mutation, user interaction), write at minimum: 1 happy-path test + 1 negative/error-path test (e.g., invalid input rejected, API failure shows error, missing data shows empty state). AC items that are purely structural (prompt changes, documentation, config wiring with no runtime behavior) are exempt from this minimum.

   **b. Green — implement until tests pass.**
   Write the production code for that module. Follow existing patterns found during the plan phase. Run the test file again to confirm green. Fix failures before moving to the next module.

   **c. Commit.**
   Once the module's tests pass, commit with `#<id>` prefix (e.g., `#58 Add Newznab search adapter`).

   **d. Sibling enumeration (blast radius check).**
   After committing, check whether the change is cross-cutting (e.g., schema field added, type renamed, shared interface changed, test fixture updated). If so, grep for **all** files that reference the changed pattern and verify every one is updated. Enumerate the full list — do not use "e.g." or partial examples. If siblings are missed, fix them before moving to the next module.

   **e. Repeat** for the next module in the plan.

   **General rules:**
   - Follow Acceptance Criteria as a checklist — each AC maps to something you must build and verify
   - **AC contracts need assertion tests.** If an AC specifies a query contract (sort order, filter behavior, join behavior, pagination), write a test that asserts the contract directly — not just that data comes back in the right shape. If an AC says "sorted by date descending," the test must verify ordering, not just row count.
   - **Derive from schema, don't build from memory.** When creating partial selects, response shapes, or form defaults, start from the actual schema/type definition and subtract — don't build include-lists from memory. Read `src/db/schema.ts` for DB columns, `src/shared/schemas/` for Zod types.
   - **Follow design principles** (CLAUDE.md § Design Principles) — single responsibility per file, DRY (extract shared patterns), extend don't modify (new files over growing lists). If the plan comment flagged design warnings, address them during implementation.
   - **Stay in scope** — if requirements expand beyond the issue spec, write `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/stopped`, run `node scripts/block.ts <id> "<reason>"` and STOP

5. **Run quality gates:** Execute `node scripts/verify.ts`
   - If output starts with `VERIFY: fail` → fix failures and re-run (max 2 attempts)
   - If still failing after 2 attempts → write `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/stopped`, run `node scripts/block.ts <id> "Quality gates failing after 2 fix attempts"` and STOP
   - If output starts with `VERIFY: pass` → continue to step 6 RIGHT NOW. You have 4 more steps to complete.

5b. **Branch guard:** Run `git branch --show-current` and verify the output matches `feature/issue-<id>-*`. If not, STOP: "Branch mismatch before frontend-design — expected feature/issue-<id>-*, got <actual>." Save the branch name.

6. **Frontend design pass (if applicable):** Check the issue labels or spec for frontend scope (`scope/frontend`).
   - If the issue includes frontend work → invoke the `frontend-design` skill on each new or significantly changed UI component. Include "Current branch: `<branch-name>`" in your message. The goal is production-grade polish, not just functional correctness.
   - If the `frontend-design` skill is not available (it's an external plugin — check the skills list in system reminders), skip this step and note it in the handoff.
   - If the issue is backend-only → skip this step.

6c. **Write phase marker:** `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/implement-complete`

### Phase 4 — Handoff

6b. **Branch guard:** Run `git branch --show-current` and verify the output matches `feature/issue-<id>-*`. If not, STOP: "Branch mismatch before /handoff — expected feature/issue-<id>-*, got <actual>." Save the branch name.

6d. **Drain background tasks (pre-handoff):** Run TaskList to check for any outstanding background tasks. For each task still in `running` state, call TaskStop to terminate it. Wait until TaskList shows no running tasks before proceeding. This prevents orphaned background tasks from keeping the session alive after handoff completes.

7. **Invoke `/handoff <id>`** via the Skill tool. Include in your message: "Current branch: `<branch-name-from-step-6b>`".
   - This pushes, creates the PR, updates labels, posts the handoff comment, updates the context cache, and appends the workflow log.
   - **When `/handoff` returns → IMMEDIATELY continue to step 8.** Do not end your turn.

8. **Verify label transition (safety net):** Check both sides of the bridge:
   - Run `node scripts/gh.tsissue view <id> --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'` and check that the issue has `status/in-review`. If missing:
     - Run: `node scripts/update-labels.ts <id> --replace "status/" "status/in-review"`
   - Run `node scripts/gh.tspr view <pr-number> --json number,state,title,headRefName,baseRefName,author,headRefOid,url,labels,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\n\(.headRefName) → \(.baseRefName) | author: \(.author.login) | sha: \(.headRefOid) | \(.url)\nlabels: \([.labels[].name] | join(", "))\n\n\(.body // "")"'` and check that the PR has `stage/review-pr`. If missing:
     - Run: `node scripts/update-labels.ts <pr-number> --pr --replace "stage/" "stage/review-pr"`
   - **Both checks are critical for the orchestrator pipeline** — the PR label drives review dispatch, the issue label tracks workflow state.

9. **Drain background tasks (post-handoff):** Run TaskList again. `/handoff` may have spawned its own background tasks (coverage subagent, self-review, etc.). For each task still in `running` state, call TaskStop to terminate it. Do not proceed until TaskList shows no running tasks. **This is critical** — any outstanding background task will keep the session alive indefinitely after completion.

10. **Write final phase marker and clean up:** `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/handoff-complete`
   - Then clean up state: `rm -rf .narratorr/state/implement-<id>/`

11. **Report completion** to the user: "**#<id> complete** — <PR link> — <1-line summary of what was built>"

## Important

- Each phase gates the next — if any phase STOPs, write `mkdir -p .narratorr/state/implement-<id> && echo done > .narratorr/state/implement-<id>/stopped` first, then STOP
- Do NOT skip claim, `/plan`, or `/handoff` — claim runs via script, `/plan` and `/handoff` via the Skill tool
- Scope creep is a STOP condition, not a TODO — write the stopped marker, run `node scripts/block.ts` and halt
