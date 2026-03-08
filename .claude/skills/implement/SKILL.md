---
name: implement
description: Full lifecycle implementation of a Gitea issue — claims, plans, implements,
  and hands off with a PR. Use when user says "implement issue", "build this", or
  invokes /implement.
argument-hint: <issue-id>
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: "The agent is running /implement (claim → plan → implement → handoff). Check its last message. It is DONE only if it contains a completion report like '**#<id> complete** — <PR link>' or an explicit STOP/block condition. If the last message is a verify summary (OVERALL: pass/fail), a plan summary, a claim confirmation, or any mid-workflow output without a PR link or STOP, respond {\"ok\": false, \"reason\": \"Workflow incomplete. You are mid-skill — continue to the next phase immediately.\"}. If complete or blocked, respond {\"ok\": true}."
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/workflow.md`

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

# /implement <id> — Full lifecycle: claim → plan → implement → handoff

End-to-end orchestrator skill. Claims the issue, plans the implementation, builds it, and hands off with a PR.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

### Phase 1 — Claim

1. **Claim the issue** by running: `node scripts/claim.ts <id>`
   - If output starts with `ERROR:` → the entire `/implement` STOPS. Do not continue.
   - If output starts with `CLAIMED:` → IMMEDIATELY continue to Phase 2. Do not end your turn.

### Phase 2 — Plan

2. **Invoke `/plan <id>`** via the Skill tool.
   - `/plan` explores the codebase, extracts test stubs from the spec, and posts a structured implementation plan on the issue.
   - The plan comment and test stubs feed directly into the implementation phase.
   - **When `/plan` returns → IMMEDIATELY continue to Phase 3.** Do not end your turn.

### Phase 3 — Implement

3. **Read the issue spec one final time** — it may have been updated during elaboration:
   - `gitea issue $ARGUMENTS`

4. **Implement the feature/fix:**
   - Follow Acceptance Criteria as a checklist — each AC maps to something you must build and verify
   - Follow existing patterns found during the plan phase (adapters, services, routes, tests)
   - **Follow design principles** (CLAUDE.md § Design Principles) — single responsibility per file, DRY (extract shared patterns), extend don't modify (new files over growing lists). If the plan comment flagged design warnings, address them during implementation.
   - Write/update tests per the Test Plan
   - Commit incrementally with `#<id>` prefix (e.g., `#58 Add Newznab search adapter`)
   - **Stay in scope** — if requirements expand beyond the issue spec, run `node scripts/block.ts <id> "<reason>"` and STOP

5. **Run quality gates:** Execute `node scripts/verify.ts`
   - If output starts with `VERIFY: fail` → fix failures and re-run (max 2 attempts)
   - If still failing after 2 attempts → run `node scripts/block.ts <id> "Quality gates failing after 2 fix attempts"` and STOP
   - If output starts with `VERIFY: pass` → continue to step 6 RIGHT NOW. You have 4 more steps to complete.

6. **Frontend design pass (if applicable):** Check the issue labels or spec for frontend scope (`scope/frontend`).
   - If the issue includes frontend work → invoke the `frontend-design` skill on each new or significantly changed UI component. The goal is production-grade polish, not just functional correctness.
   - If the `frontend-design` skill is not available (it's an external plugin — check the skills list in system reminders), skip this step and note it in the handoff.
   - If the issue is backend-only → skip this step.

### Phase 4 — Handoff

7. **Invoke `/handoff <id>`** via the Skill tool.
   - This pushes, creates the PR, updates labels, posts the handoff comment, updates the context cache, and appends the workflow log.
   - **When `/handoff` returns → IMMEDIATELY continue to step 8.** Do not end your turn.

8. **Verify label transition (safety net):** Run `gitea issue <id>` and check that the issue has `stage/review-pr`. If `/handoff` didn't set it (this happens with some agents):
   - Read the current labels from the issue output
   - Replace any `stage/*` label with `stage/review-pr` (keep `status/in-progress` and all other labels)
   - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `stage/review-pr`
   - **This step is critical for the orchestrator pipeline** — without `stage/review-pr`, the PR will never be picked up for review.

9. **Report completion** to the user: "**#<id> complete** — <PR link> — <1-line summary of what was built>"

## Important

- **Do NOT pause between phases or after sub-skill returns.** When `/claim`, `/plan`, or `/handoff` returns, immediately continue to the next step. Sub-skill results are mid-flow return values, not stopping points. The only valid stops are explicit STOP conditions (blocked, failures after retries, scope creep).
- Each phase gates the next — if any phase STOPs, the whole skill STOPs
- Do NOT skip claim, `/plan`, or `/handoff` — claim runs via script, `/plan` and `/handoff` via the Skill tool
- Scope creep is a STOP condition, not a TODO — run `node scripts/block.ts` and halt
