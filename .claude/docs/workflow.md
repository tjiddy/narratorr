# Issue Workflow — MANDATORY

**Every task referencing a GitHub issue (#N) MUST follow this lifecycle — no exceptions.**
A detailed plan, pre-made spec, or explicit implementation instructions do NOT bypass these steps.

## Two execution modes

**Automated (preferred — add `automate` label to the issue):**
Workflume's orchestrator owns the full pipeline end-to-end: elaborate → review-spec → implement → review-pr → respond-to-pr-review → merge. These skills live in the workflume repo, not here.

**Manual (no `automate` label — human-driven):**
1. **Before writing any code** → `/claim <id>` (validates status, creates branch, updates labels)
2. **Implement** — write code, run tests, commit
3. **After tests/typecheck/build pass** → `/handoff <id>` (pushes, creates PR, comments, updates labels)
4. **Merge** → `node scripts/merge.ts <pr>` (validates approval + CI, squash-merges, closes issue)

Skipping `/claim` means no validation, no branch, no tracking, no audit trail.
Skipping `/handoff` means no PR, no label update.

## Standalone tools (any time, either mode)

- `/block <id>` — mark blocked, overlay `blocked` flag on the issue (halts automation)
- `/resume <id>` — restore a previously blocked issue's working state
- `/verify` — run lint + test + typecheck + build + e2e
- `/triage` — read-only priority analysis across open issues
- `/spec` — create a new issue from the spec template

## Workflow guardrails

- **Self-review.** The `/review-pr` skill (workflume) refuses to review a PR authored by the same identity.
- **Merge author validation.** `scripts/merge.ts` requires the most recent `approve` verdict to come from a different user than the PR author. Stale approvals (superseded by `needs-work`) are ignored.
- **Dispute escalation.** Workflume's `/respond-to-pr-review` flags the linked issue with `blocked` when a blocking finding is disputed, forcing human intervention.

## Labels

### Exclusive groups (exactly one per entity)

**Issue status (`status/*`)** — one at a time, on the issue:
`status/backlog` · `status/review-spec` · `status/fixes-spec` · `status/ready-for-dev` · `status/in-progress` · `status/in-review` · `status/done`

**PR stage (`stage/*`)** — one at a time, on the PR:
`stage/review-pr` · `stage/fixes-pr` · `stage/approved`

### Standalone flags (additive, not exclusive)

- `blocked` — something is preventing progress (overlays current status, doesn't replace it)
- `automate` — enables autonomous orchestration (workflume)

### Metadata labels (additive)

Type: `type/feature` · `type/bug` · `type/chore` | Priority: `priority/high` · `priority/medium` · `priority/low` | Scope: `scope/backend` · `scope/frontend` · `scope/core` · `scope/db` · `scope/infra` · `scope/api` · `scope/services` · `scope/ui`
