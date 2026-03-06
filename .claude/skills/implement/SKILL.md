---
name: implement
description: Full lifecycle implementation of a Gitea issue — validates, claims,
  implements, and hands off with a PR. Use when user says "implement issue", "build
  this", or invokes /implement.
argument-hint: <issue-id>
disable-model-invocation: true
---

# /implement <id> — Full lifecycle: elaborate → claim → implement → handoff

End-to-end orchestrator skill. Validates the issue, claims it, implements the solution, and hands off with a PR. Chains `/claim` and `/handoff` via the Skill tool.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

### Phase 1 — Claim (with validation)

1. **Invoke `/claim <id>`** via the Skill tool.
   - `/claim` delegates validation to a subagent (spec checks, codebase exploration, dependency checks) then claims if ready.
   - If `/claim` STOPs (blocked, not ready, PR already exists) → the entire `/implement` STOPS. Do not continue.

### Phase 2 — Implement

2. **Read the issue spec one final time** — it may have been updated during the elaborate phase:
   - `gitea issue $ARGUMENTS`

3. **Implement the feature/fix:**
   - Follow Acceptance Criteria as a checklist — each AC maps to something you must build and verify
   - Follow existing patterns found during the elaborate phase (adapters, services, routes, tests)
   - **Follow design principles** (CLAUDE.md § Design Principles) — single responsibility per file, DRY (extract shared patterns), extend don't modify (new files over growing lists). If the claim comment flagged design warnings, address them during implementation.
   - Write/update tests per the Test Plan
   - Commit incrementally with `#<id>` prefix (e.g., `#58 Add Newznab search adapter`)
   - **Stay in scope** — if requirements expand beyond the issue spec, invoke `/block <id>` via the Skill tool and STOP

4. **Run quality gates:** Invoke `/verify` via the Skill tool. It runs on haiku to keep cost down and verbose build output out of main context.

   - If OVERALL: fail → fix failures in the main context and re-invoke `/verify` (max 2 attempts)
   - If still failing after 2 fix attempts → invoke `/block <id>` via the Skill tool and STOP

5. **Frontend design pass (if applicable):** Check the issue labels or spec for frontend scope (`scope/frontend`).
   - If the issue includes frontend work → invoke the `frontend-design` skill on each new or significantly changed UI component. The goal is production-grade polish, not just functional correctness.
   - If the `frontend-design` skill is not available (it's an external plugin — check the skills list in system reminders), skip this step and note it in the handoff.
   - If the issue is backend-only → skip this step.

### Phase 3 — Handoff

6. **Invoke `/handoff <id>`** via the Skill tool.
   - This pushes, creates the PR, updates labels, posts the handoff comment, updates the context cache, and appends the workflow log.

7. **Report completion** to the user: "**#<id> complete** — <PR link> — <1-line summary of what was built>"

## Important

- **Do NOT pause between phases or after sub-skill returns.** When `/claim` or `/handoff` returns, immediately continue to the next step. Sub-skill results are mid-flow return values, not stopping points. The only valid stops are explicit STOP conditions (blocked, failures after retries, scope creep).
- Each phase gates the next — if any phase STOPs, the whole skill STOPs
- Do NOT skip `/claim` or `/handoff` — they are invoked via the Skill tool, not inlined
- The elaborate logic runs inside `/claim` as a subagent, NOT as a separate `/elaborate` call (avoids double-elaborating)
- Scope creep is a STOP condition, not a TODO — invoke `/block` and halt
