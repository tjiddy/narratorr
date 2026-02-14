# Agent Workflow (Gitea + Claude Implementor)

This document defines the **implementor workflow** for working Gitea issues in this repo. It is designed to be:
- **Idempotent** (safe to re-run without duplicating work)
- **Agent-friendly** (machine-readable conventions)
- **Token-efficient** (bounded reading on resume)

**Role:** Implementor (Claude Code)
**Goal:** Take a `status/ready` issue → implement on a branch → open a PR → update the issue for downstream agents (review/QA/merge).
**Do NOT merge** unless explicitly instructed.

> **Skills available:** `/implement <id>`, `/claim <id>`, `/handoff <id>`, `/block <id>`, `/elaborate <id>` automate the steps below. Use these for the standard workflow; refer to this doc for edge cases and templates.

---

## TL;DR (do this every time)

**Full auto (preferred):**
1. `/implement <id>` — validates spec, explores codebase, claims, implements, and hands off

**Manual control:**
1. Read issue: `pnpm gitea issue <id>`
2. Verify: label contains `status/ready`, and spec has Acceptance Criteria + Test Plan.
3. If missing info: comment `BLOCKED — need input` (template below), set `status/blocked`, stop.
4. Comment `Claiming #<id>` with a short plan; set `status/in-progress` + `stage/dev` (remove other `status/*` and `stage/*` labels).
5. Create branch: `feature/issue-<id>-<slug>`
6. Implement; run tests per Test Plan.
7. Push; create PR titled `#<id> <issue title>` with `Refs #<id>` and structured body.
8. Update labels: replace `stage/dev` with `stage/review`. Comment on issue with PR link + what changed + how verified.

**Standalone tools:**
- `/elaborate <id>` — groom/triage without claiming (no side effects on labels/branches)
- `/block <id>` — mark blocked and stop

---

## Labels and state machine

Labels use a **2-axis model**: `status/*` tracks lifecycle state, `stage/*` tracks pipeline ownership.

### Status labels (lifecycle — exactly one at all times)
- `status/backlog` — not ready for an agent
- `status/ready` — spec is complete; agent may claim
- `status/in-progress` — claimed / active work
- `status/blocked` — needs human input or external dependency
- `status/done` — work is complete

### Stage labels (pipeline ownership — exactly one when `status/in-progress`)
- `stage/dev` — implementation in progress
- `stage/review` — PR open, awaiting review
- `stage/qa` — quality assurance / testing

**Rule:** When `status/in-progress` is set, exactly ONE `stage/*` label must also be present. For all other statuses, `stage/*` labels should be absent (except `status/blocked`, which keeps its current `stage/*` to indicate where to resume).

### Transition map

| Event | status/* | stage/* |
|---|---|---|
| Claim issue | `status/in-progress` | `stage/dev` |
| PR opened (handoff) | `status/in-progress` | `stage/review` |
| Changes requested | `status/in-progress` | `stage/dev` |
| QA starts | `status/in-progress` | `stage/qa` |
| QA passed / done | `status/done` | _(clear)_ |
| Blocked | `status/blocked` | _(keep current)_ |
| Unblocked | `status/in-progress` | _(restore previous)_ |

### Type labels (what it is)
- `type/feature`, `type/bug`, `type/chore`

### Priority labels (urgency)
- `priority/high`, `priority/medium`, `priority/low`

> If multiple `status/*`, `stage/*`, or `priority/*` labels exist in the same group, remove extras so only one remains per group.

---

## Naming conventions (must follow)

### Branch
`feature/issue-<id>-<slug>`

Examples:
- `feature/issue-123-add-user-pref`
- `feature/issue-88-fix-null-guard`

### Commit message
Start with `#<id> `

Examples:
- `#123 Add null guard for profile`
- `#123 Update docs for config`

### PR title
`#<id> <issue title>`

### PR body
Must include the sections in the PR template below and **must include**: `Refs #<id>`.

> Use `Refs #<id>` (not `Closes #<id>`) unless explicitly instructed to auto-close on merge.

---

## Step-by-step workflow (detailed)

## 0) Pre-flight: Validation (before you change anything)

> This phase is automated by `/claim` (inline) and available standalone via `/elaborate`.

1. Read issue:
    - `pnpm gitea issue <id>`

2. **Parse spec completeness.** Verify the issue body contains:
    - **Acceptance Criteria** — clear, testable statements (REQUIRED)
    - **Test Plan** — specific test cases or commands (REQUIRED)
    - **Implementation detail** — file paths, service/route names (recommended)
    - **Dependencies** — references to other issues, with their status checked (recommended)
    - **Scope boundaries** — what's explicitly out of scope (recommended)

3. **Explore codebase for relevant patterns:**
    - Find similar existing features (adapters, services, routes)
    - Check interfaces/types in `packages/core/src/*/types.ts`, `shared/schemas.ts`, `packages/db/src/schema.ts`
    - Identify wiring/touch points (`routes/index.ts`, `services/`, `App.tsx`, `Layout.tsx`)

4. **Check for overlapping work:**
    - `pnpm gitea prs` — any open PR touching the same area?
    - Any `status/in-progress` issues that overlap?

5. **Check dependencies:**
    - Referenced issues → verify they are `status/done`

6. **Fill gaps** from codebase knowledge:
    - If implementation detail can be inferred, append to issue body (preserve existing content)
    - `pnpm gitea issue-update <id> body --body-file <temp-file>`

7. **Gate on readiness:**
    - **Ready** — AC testable, test plan specific, implementation path clear, no blockers → proceed to Phase 1
    - **Needs detail (filled)** — had gaps, filled from codebase, now ready → proceed to Phase 1
    - **Not ready** — ambiguous requirements, missing AC/test plan, unresolved deps →
        - Post a BLOCKED comment (template below)
        - Set label to `status/blocked`
        - STOP (do not create a branch or commit anything)

---

## 1) Claim & Plan

Post a claim comment on the issue, then set `status/in-progress` + `stage/dev`.

### Claim comment template
**Claiming #<id>**
- Plan:
    1. ...
    2. ...
    3. ...
- Expected changes: `<files/modules>`
- Verification: `<tests you will run>`

Then replace labels (setting `status/in-progress` + `stage/dev`, removing other `status/*` and `stage/*`):

```bash
pnpm gitea issue-update <id> labels "priority/high,scope/core,status/in-progress,stage/dev,type/feature"
```

The script accepts label names (or numeric IDs) and prints the resulting labels.

**Verify the output shows `status/in-progress` and `stage/dev`. If the command fails, STOP — you have not claimed the issue.**

---

## 2) Create branch

1. Sync default branch:
    - `git checkout main` (or repo default)
    - `git pull`

2. Create your branch:
    - `git checkout -b feature/issue-<id>-<slug>`

---

## 3) Implement

Rules:
- Stick to scope. If scope needs to change, comment and block.
- Prefer small, reviewable diffs.
- **Write/update tests for all new/changed code.** Follow existing patterns:
    - Backend services: unit tests with mocked DB (`services/*.test.ts`)
    - API routes: integration tests with Fastify `inject()` (`routes/*.test.ts`)
    - Core adapters: unit tests with MSW for HTTP mocking (`packages/core/**/*.test.ts`)
    - Frontend components/pages: render tests with Testing Library (`*.test.tsx`)
    - Frontend hooks: `renderHook` tests (`*.test.ts` or `*.test.tsx`)
    - Utilities: pure function unit tests (`*.test.ts`)
- If you need to create additional issues (bugs), do it (see "Defects" section).
- If your changes make `README.md` or `CLAUDE.md` inaccurate (new features, API routes, config options, project structure, commands, etc.), update them as part of the PR.

---

## 4) Verify locally (required)

Run **all** of the following:
- `pnpm lint` — no lint errors
- `pnpm test` — all tests must pass (zero failures)
- `pnpm typecheck` — no type errors
- `pnpm build` — clean build
- Manual steps from Test Plan (if any)

If you cannot make tests pass:
- Do not open a PR that is red without explanation.
- Fix it or set `status/blocked` with details and stop.

---

## 5) Push + Create PR

1. Commit with clear messages:
    - `git commit -m "#<id> <short summary>"`

2. Push branch:
    - `git push -u origin feature/issue-<id>-<slug>`

3. Create PR:
    - Base: default branch
    - Title: `#<id> <issue title>`
    - Body: Use PR template below
    - Must include: `Refs #<id>`

### PR body template
**Refs:** #<id>

## Summary
- ...

## Acceptance Criteria
- [ ] AC1 ...
- [ ] AC2 ...

## Tests / Verification
- Commands:
    - `...`
- Manual:
    - ...

## Screenshots / Video (if UI)
- ...

## Risk / Rollback
- Risk: low/med/high — why
- Rollback: revert PR / revert commit / toggle flag

4. Switch back to main:
    - `git checkout main`

---

## 6) Update the issue (handoff)

After PR is opened:

1. **Update labels** — replace `stage/dev` with `stage/review` (keep `status/in-progress` and all other labels):
   ```bash
   pnpm gitea issue-update <id> labels "<labels with stage/dev replaced by stage/review>"
   ```

2. **Comment on the issue:**

### Handoff comment template
**PR ready:** <PR link>

- What changed:
    - ...
- How verified:
    - ...
- Notes / follow-ups:
    - ...

Leave issue labeled `status/in-progress` + `stage/review`.
Do not close the issue unless explicitly told to.

---

## BLOCKED workflow (ask questions in issue comments)

When you cannot proceed due to missing info/ambiguity/dependency:

1. Post a BLOCKED comment (template below)
2. Set label `status/blocked` (keep current `stage/*` label so we know where to resume)
3. STOP

### BLOCKED comment template
**BLOCKED — need input**

Context: <1–2 sentences about what you attempted and where you got stuck>

Decision needed:
1. <Question 1?>
    - A) ...
    - B) ...
    - C) ...
    - Default if no answer: A
2. <Question 2?>
    - A) ...
    - B) ...
    - Default if no answer: A

Once answered, I will: <1 sentence>

---

## Resume workflow (token-efficient)

When re-running on a blocked issue:

1. Read issue: `pnpm gitea issue <id>`
2. Find the **most recent** comment containing `BLOCKED — need input`
3. Read only:
    - That BLOCKED comment
    - All comments after it
4. Extract answers by number (e.g., `1) B`, `2) A`)
5. Continue implementation on the existing branch (do not create a new one)

If the answers do not resolve the block:
- Post a new BLOCKED comment with updated questions
- Keep `status/blocked` (and current `stage/*`)
- Stop

---

## Handling defects found while implementing a story

If you discover a defect while implementing/testing:

1. Create a NEW issue:
    - Label: `type/bug`
    - Set appropriate `priority/*`
    - Set `status/ready` only if it is immediately actionable; otherwise `status/backlog`

2. In the bug description, include:
    - “Found while working on #<storyId>”
    - Repro steps
    - Expected vs actual
    - Logs/screenshots if applicable

3. Link it by referencing `#<storyId>` in the bug issue body.

If the bug must be fixed to complete the story, either:
- Fix it in the same branch/PR and mention it in the PR summary, OR
- Explicitly note in the story handoff what is still required.

---

## 7) Retrospective (after every issue)

After completing work on an issue (whether via handoff, block, or any other stopping point), append an entry to `.claude/workflow-log.md`. Create the file if it doesn't exist.

### Template

```
## #<id> <issue title> — <date>
**Skill path:** /claim → /handoff (or /claim → /block, etc.)
**Outcome:** success | partial | blocked

### Workflow experience
- What went smoothly: ...
- Friction / issues encountered: ...
- Suggestions for workflow or skill improvements: ...

### Token efficiency
- Highest-token actions: (e.g. "read large file X twice", "build output was 500 lines", "re-read issue after context loss")
- Avoidable waste: (e.g. "could have used --filter to reduce build output", "didn't need to re-read the spec")
- Suggestions: ...

### Infrastructure gaps
- Repeated code/setup/workarounds: (e.g. "copy-pasted matchMedia mock into 3 test files — should be in global setup")
- Missing tooling or config: (e.g. "no global test cleanup — needed manual afterEach(cleanup) in every component test")
- Unresolved items / debt: (things discovered but NOT fixed — create issues or note here so they don't get lost)
```

Keep it concise — aim for 5-15 bullet points total across all sections.

---

## Safety / Idempotency rules (must follow)

- If an open PR already references `#<id>`, do not start parallel work.
- Do not silently expand scope. Block and ask.
- Every major transition must be recorded in the issue:
    - Claim
    - PR opened
    - Blocked questions
    - Verification performed
- Keep the paper trail tight and structured to avoid token blowups.
