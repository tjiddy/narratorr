# Agent Workflow (Gitea + Claude Implementor)

This document defines the **implementor workflow** for working Gitea issues in this repo. It is designed to be:
- **Idempotent** (safe to re-run without duplicating work)
- **Agent-friendly** (machine-readable conventions)
- **Token-efficient** (bounded reading on resume)

**Role:** Implementor (Claude Code)  
**Goal:** Take a `status:ready` issue → implement on a branch → open a PR → update the issue for downstream agents (review/QA/merge).  
**Do NOT merge** unless explicitly instructed.

---

## TL;DR (do this every time)

1. Read issue: `./scripts/gitea.sh issue <id>`
2. Verify: label contains `status:ready`, and spec has Acceptance Criteria + Test Plan.
3. If missing info: comment `BLOCKED — need input` (template below), set `status:blocked`, stop.
4. Comment `Claiming #<id>` with a short plan; set `status:in-progress` (remove other `status:*` labels).
5. Create branch: `feature/issue-<id>-<slug>`
6. Implement; run tests per Test Plan.
7. Push; create PR titled `#<id> <issue title>` with `Refs #<id>` and structured body.
8. Comment on issue with PR link + what changed + how verified. Leave issue `status:in-progress`.

---

## Labels and state machine

### Status labels (single source of workflow state)
- `status:backlog` — not ready for an agent
- `status:ready` — spec is complete; agent may claim
- `status:in-progress` — claimed / active work
- `status:blocked` — needs human input or external dependency

**Done is represented by the issue being CLOSED** (unless the repo chooses otherwise).

### Type labels (what it is)
- `type:feature`, `type:bug`, `type:chore`

### Priority labels (urgency)
- `priority:high`, `priority:medium`, `priority:low`

> If multiple `status:*` or `priority:*` labels exist, remove extras so only one remains. Prefer enforcing this in automation.

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

## 0) Pre-flight (before you change anything)

1. Read issue:
    - `./scripts/gitea.sh issue <id>`

2. Verify ALL of the following:
    - Issue includes `status:ready`
    - Acceptance Criteria exist (checkboxes preferred)
    - Test Plan exists (commands + manual steps)
    - No existing open PR already references `#<id>` (search PR list or repo for `#<id>` / `issue-<id>`)

3. If anything is missing/ambiguous:
    - Post a BLOCKED comment (template below)
    - Set label to `status:blocked`
    - STOP (do not create a branch or commit anything)

---

## 1) Claim & Plan

Post a claim comment on the issue, then set `status:in-progress`.

### Claim comment template
**Claiming #<id>**
- Plan:
    1. ...
    2. ...
    3. ...
- Expected changes: `<files/modules>`
- Verification: `<tests you will run>`

Then:
- Add label `status:in-progress`
- Remove any other `status:*` labels

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
- If you need to create additional issues (bugs), do it (see “Defects” section).

---

## 4) Verify locally (required)

Run the minimal set of checks that prove Acceptance Criteria:
- Lint/format (if applicable)
- Unit tests (if applicable)
- Manual steps from Test Plan
- Any UI screenshot/recording requested

If you cannot make tests pass:
- Do not open a PR that is red without explanation.
- Fix it or set `status:blocked` with details and stop.

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

---

## 6) Update the issue (handoff)

After PR is opened, comment on the issue:

### Handoff comment template
**PR ready:** <PR link>

- What changed:
    - ...
- How verified:
    - ...
- Notes / follow-ups:
    - ...

Leave issue labeled `status:in-progress` (do not move to ready).  
Do not close the issue unless explicitly told to.

---

## BLOCKED workflow (ask questions in issue comments)

When you cannot proceed due to missing info/ambiguity/dependency:

1. Post a BLOCKED comment (template below)
2. Set label `status:blocked`
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

1. Read issue: `./scripts/gitea.sh issue <id>`
2. Find the **most recent** comment containing `BLOCKED — need input`
3. Read only:
    - That BLOCKED comment
    - All comments after it
4. Extract answers by number (e.g., `1) B`, `2) A`)
5. Continue implementation on the existing branch (do not create a new one)

If the answers do not resolve the block:
- Post a new BLOCKED comment with updated questions
- Keep `status:blocked`
- Stop

---

## Handling defects found while implementing a story

If you discover a defect while implementing/testing:

1. Create a NEW issue:
    - Label: `type:bug`
    - Set appropriate `priority:*`
    - Set `status:ready` only if it is immediately actionable; otherwise `status:backlog`

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

## Safety / Idempotency rules (must follow)

- If an open PR already references `#<id>`, do not start parallel work.
- Do not silently expand scope. Block and ask.
- Every major transition must be recorded in the issue:
    - Claim
    - PR opened
    - Blocked questions
    - Verification performed
- Keep the paper trail tight and structured to avoid token blowups.
