# /implement <id> — Full lifecycle: elaborate → claim → implement → handoff

End-to-end orchestrator skill. Validates the issue, claims it, implements the solution, and hands off with a PR. Chains `/claim` and `/handoff` via the Skill tool.

## Steps

### Phase 1 — Claim (with validation)

1. **Invoke `/claim <id>`** via the Skill tool.
   - `/claim` runs elaborate logic inline (spec validation, codebase exploration, dependency checks) then claims if ready.
   - If `/claim` STOPs (blocked, not ready, PR already exists) → the entire `/implement` STOPS. Do not continue.

### Phase 2 — Implement

2. **Read the issue spec one final time** — it may have been updated during the elaborate phase:
   - `pnpm gitea issue $ARGUMENTS`

3. **Implement the feature/fix:**
   - Follow Acceptance Criteria as a checklist — each AC maps to something you must build and verify
   - Follow existing patterns found during the elaborate phase (adapters, services, routes, tests)
   - Write/update tests per the Test Plan
   - Commit incrementally with `#<id>` prefix (e.g., `#58 Add Newznab search adapter`)
   - **Stay in scope** — if requirements expand beyond the issue spec, invoke `/block <id>` via the Skill tool and STOP

4. **Run quality gates:**
   ```bash
   pnpm lint && pnpm test && pnpm typecheck && pnpm build
   ```
   - Fix any failures and re-run
   - If stuck after 2 fix attempts → invoke `/block <id>` via the Skill tool and STOP

### Phase 3 — Handoff

5. **Invoke `/handoff <id>`** via the Skill tool.
   - This pushes, creates the PR, updates labels, posts the handoff comment, and appends the workflow log.

6. **Report completion** to the user with the PR link and a summary of what was built.

## Important

- Each phase gates the next — if any phase STOPs, the whole skill STOPs
- Do NOT skip `/claim` or `/handoff` — they are invoked via the Skill tool, not inlined
- The elaborate logic runs inside `/claim`, NOT as a separate `/elaborate` call (avoids double-elaborating)
- Scope creep is a STOP condition, not a TODO — invoke `/block` and halt
