# Issue Workflow — MANDATORY

**Every task referencing a GitHub issue (#N) MUST follow this lifecycle — no exceptions.**
A detailed plan, pre-made spec, or explicit implementation instructions do NOT bypass these steps.

**Full auto (preferred):**
1. `/implement <id>` — claims, plans, implements, and hands off in one pass

**Manual control:**
1. **Before writing any code** → `/claim <id>` (validates status, creates branch, updates labels)
2. **Plan** → `/plan <id>` (explores codebase, extracts test stubs, posts implementation plan)
3. **Implement** — follow the plan from step 2
4. **After tests/typecheck/build pass** → `/handoff <id>` (pushes, creates PR, comments, updates labels, appends workflow log)

**PR review cycle:**
1. `/review-pr <pr>` — reviewer posts structured findings with verdict
2. `/respond-to-pr-review <pr>` — author addresses each finding (fix/accept/defer/dispute), pushes, posts response
3. `/review-pr <pr>` — re-review after fixes (repeat until approved)
4. `node scripts/merge.ts <pr>` — squash merge once verdict is `approve`

**Standalone tools:**
- `/elaborate <id>` — groom/triage without claiming (no side effects)
- `/block <id>` — mark blocked and stop (at any point)

Skipping `/claim` means no validation, no branch, no tracking, no audit trail.
Skipping `/handoff` means no PR, no label update, no workflow log entry.

**Workflow guardrails:**
- **No pausing between sub-skills.** When `/plan`, `/handoff`, or a script (`verify.ts`, `claim.ts`) returns inside a parent skill (`/implement`, `/respond-to-pr-review`), immediately continue the parent flow. These are mid-flow return values, not stopping points.
- **Self-review guard.** `/review-pr` checks the current user against the PR author — if they match, it STOPs and suggests `/respond-to-pr-review` instead.
- **Merge author validation.** `scripts/merge.ts` requires the most recent `approve` verdict to come from a different user than the PR author. Stale approvals (superseded by `needs-work`) are ignored.
- **Dispute escalation.** If `/respond-to-pr-review` disputes a blocking finding, the issue gets the `blocked` flag and STOPs for human input.
- **Auto-maintained files.** `/handoff` prepends to `.claude/cl/workflow-log.md`.

## Labels

### Exclusive groups (exactly one per entity)

**Issue status (`status/*`)** — one at a time, on the issue:
`status/backlog` · `status/review-spec` · `status/fixes-spec` · `status/ready-for-dev` · `status/in-progress` · `status/in-review` · `status/done`

**PR stage (`stage/*`)** — one at a time, on the PR:
`stage/review-pr` · `stage/fixes-pr` · `stage/approved`

### Standalone flags (additive, not exclusive)

- `blocked` — something is preventing progress (overlays current status, doesn't replace it)
- `automate` — enables autonomous orchestration (narrator-automate)

### Metadata labels (additive)

Type: `type/feature` · `type/bug` · `type/chore` | Priority: `priority/high` · `priority/medium` · `priority/low` | Scope: `scope/backend` · `scope/frontend` · `scope/core` · `scope/db` · `scope/infra` · `scope/api` · `scope/services` · `scope/ui`

