---
name: implement
description: Full lifecycle implementation of a Gitea issue — claims, plans, implements,
  and hands off with a PR. Use when user says "implement issue", "build this", or
  invokes /implement.
argument-hint: <issue-id>
disable-model-invocation: true
---

# /implement <id> — Full lifecycle: claim → plan → implement → handoff

End-to-end orchestrator skill. Claims the issue, plans the implementation, builds it, and hands off with a PR. Chains `/claim`, `/plan`, and `/handoff` via the Skill tool.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

### Phase 1 — Claim

1. **Invoke `/claim <id>`** via the Skill tool.
   - `/claim` validates the issue status, creates the feature branch, and updates labels.
   - If `/claim` STOPs (blocked, not ready, PR already exists) → the entire `/implement` STOPS. Do not continue.

### Phase 2 — Plan

2. **Invoke `/plan <id>`** via the Skill tool.
   - `/plan` explores the codebase, extracts test stubs from the spec, and posts a structured implementation plan on the issue.
   - The plan comment and test stubs feed directly into the implementation phase.

### Phase 3 — Implement

3. **Read the issue spec one final time** — it may have been updated during elaboration:
   - `gitea issue $ARGUMENTS`

4. **Implement the feature/fix:**
   - Follow Acceptance Criteria as a checklist — each AC maps to something you must build and verify
   - Follow existing patterns found during the plan phase (adapters, services, routes, tests)
   - **Follow design principles** (CLAUDE.md § Design Principles) — single responsibility per file, DRY (extract shared patterns), extend don't modify (new files over growing lists). If the plan comment flagged design warnings, address them during implementation.
   - Write/update tests per the Test Plan
   - Commit incrementally with `#<id>` prefix (e.g., `#58 Add Newznab search adapter`)
   - **Stay in scope** — if requirements expand beyond the issue spec, invoke `/block <id>` via the Skill tool and STOP

5. **Run quality gates:** Invoke `/verify` via the Skill tool. It runs on haiku to keep cost down and verbose build output out of main context.

   - If OVERALL: fail → fix failures in the main context and re-invoke `/verify` (max 2 attempts)
   - If still failing after 2 fix attempts → invoke `/block <id>` via the Skill tool and STOP

6. **Frontend design pass (if applicable):** Check the issue labels or spec for frontend scope (`scope/frontend`).
   - If the issue includes frontend work → invoke the `frontend-design` skill on each new or significantly changed UI component. The goal is production-grade polish, not just functional correctness.
   - If the `frontend-design` skill is not available (it's an external plugin — check the skills list in system reminders), skip this step and note it in the handoff.
   - If the issue is backend-only → skip this step.

### Phase 4 — Handoff

7. **Invoke `/handoff <id>`** via the Skill tool.
   - This pushes, creates the PR, updates labels, posts the handoff comment, updates the context cache, and appends the workflow log.

8. **Report completion** to the user: "**#<id> complete** — <PR link> — <1-line summary of what was built>"

## Important

- **Do NOT pause between phases or after sub-skill returns.** When `/claim`, `/plan`, or `/handoff` returns, immediately continue to the next step. Sub-skill results are mid-flow return values, not stopping points. The only valid stops are explicit STOP conditions (blocked, failures after retries, scope creep).
- Each phase gates the next — if any phase STOPs, the whole skill STOPs
- Do NOT skip `/claim`, `/plan`, or `/handoff` — they are invoked via the Skill tool, not inlined
- Scope creep is a STOP condition, not a TODO — invoke `/block` and halt
