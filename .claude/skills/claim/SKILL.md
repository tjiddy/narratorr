# /claim <id> — Claim a spec-approved Gitea issue for implementation

Claims an issue that has passed spec review (`status/ready`). Creates the feature branch, extracts test stubs, and posts a claim comment with the implementation plan.

**Prerequisite:** The issue must have `status/ready` (set by `/review-spec` on approval). Issues still in `status/backlog` must go through `/review-spec` first.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Phase 1 — Gate on spec approval

1. **Read the issue:** Run `gitea issue <id>`. Extract title, labels, body, and comments.

2. **Check status label:**
   - **`status/ready`** → proceed to Phase 2
   - **`status/backlog`** →
     - Check if the issue has any `## Spec Review` comments (from `/review-spec`)
     - If it has spec review comments with `needs-work` verdict: STOP — "Issue #<id> has unresolved spec review findings. Update the spec to address findings, then re-run `/review-spec <id>`."
     - If it has no spec review comments: STOP — "Issue #<id> hasn't been through spec review yet. Run `/review-spec <id>` first."
   - **`status/in-progress`** → STOP — "Issue #<id> is already in progress."
   - **`status/blocked`** → STOP — "Issue #<id> is blocked. Check issue comments for details, or run `/resume <id>`."

3. **Check for existing PRs:**
   - Run `gitea prs` and check if any open PR title contains `#<id>`.
   - If one exists, STOP: "PR already open for #<id>: <PR link>"

4. **Explore the codebase** for implementation planning:
   - Read `.claude/project-context.md` for recent changes context
   - Read CLAUDE.md for design principles and conventions
   - Explore files/modules relevant to the issue scope
   - Check for overlapping work: `gitea prs`
   - Check dependencies: `gitea issue <dep-id>` for any referenced issues
   - Identify relevant patterns, interfaces, wiring points
   - **Surface past learnings:** Scan `.claude/learnings/` for files whose `scope` or `files` frontmatter matches this issue's labels or target files. Also check `.claude/debt.md` for items in the target area. Include relevant learnings in the claim comment under a **"Known Learnings"** heading — these are things that bit previous implementations in the same area.

## Phase 2 — Claim

5. **Post a claim comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **Claiming #<id>**
   - Plan:
       1. ...
       2. ...
       3. ...
   - Expected changes: `<files/modules>`
   - Verification: `<tests to run>`
   - Codebase findings: <relevant patterns, interfaces, wiring points>
   - Known learnings: <relevant learnings from `.claude/learnings/` and `.claude/debt.md`, or "none">
   - Design checklist:
       - [ ] Each new file has a single responsibility
       - [ ] No duplicated patterns — reuses existing hooks/components or extracts shared ones
       - [ ] Wiring touches ≤3 existing files (new features extend, not modify)
       - [ ] Types and components co-located with their domain
   ```
   If any design check fails, note the mitigation.
   - Clean up the temp file after posting.

6. **Set labels to `status/in-progress` + `stage/dev`** (keeping all other existing labels):
   - From the issue output, extract the current label names.
   - Replace any `status/*` label with `status/in-progress`.
   - Replace any `stage/*` label with `stage/dev` (or add `stage/dev` if none exists).
   - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `status/in-progress` and `stage/dev`. If it doesn't, STOP and report the error.

7. **Create the feature branch:**
   ```bash
   git stash --include-untracked
   git checkout main
   git pull
   ```
   Then check if main is ahead of origin: `git rev-list --count origin/main..main`
   - If count > 0: push first (`git push origin main`). If push fails (diverged), run `git pull --rebase origin main` then push.
   - If count = 0: proceed.
   ```bash
   git checkout -b feature/issue-<id>-<slug>
   git stash pop
   ```
   where `<slug>` is a short kebab-case summary of the issue title.

   Note: `git stash pop` may silently succeed with no stash if working directory was clean — that's fine.

8. **Extract test stubs from spec (if present).**
   Scan the issue body for `## User Interactions`, `## System Behaviors`, and `## Edge Cases (auto-generated)` sections (or equivalent interaction-style requirements like "user does X → Y" / "when X → Y" anywhere in the spec):

   **For User Interactions** (frontend):
   - Create `it.todo('description')` stubs in co-located test files next to the planned frontend files (e.g., `ManualImportPage.tsx` → `ManualImportPage.test.tsx`)

   **For System Behaviors** (backend/core):
   - Create `it.todo('description')` stubs in co-located test files next to the planned service/route/utility files (e.g., `match-job.service.ts` → `match-job.service.test.ts`)

   **For both:**
   - Group stubs by component/module using `describe()` blocks
   - Each stub should map to one interaction or behavior from the spec
   - If test files already exist, append new `describe`/`it.todo` blocks — don't overwrite existing tests
   - If test files don't exist yet, create them with the standard imports (`describe`, `it`, `vi` from `vitest`) and leave the actual test setup (mocks, render helpers) for the implementer
   - If neither spec section exists, skip this step (older issues won't have it)

   Example — given a spec interaction "User clicks 'Cancel' → modal closes":
   ```ts
   describe('MyComponent', () => {
     it.todo('closes modal when user clicks Cancel');
   });
   ```

   These stubs are the **minimum test coverage** — every spec interaction and system behavior must have a corresponding test. The implementer should add additional tests beyond these stubs for edge cases, error states, and implementation details discovered during development. The stubs are a floor, not a ceiling.

9. Tell the user the issue is claimed and show the plan, including codebase findings from step 4.
