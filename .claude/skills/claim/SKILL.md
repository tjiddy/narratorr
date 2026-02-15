# /claim <id> — Validate and claim a Gitea issue

Enhanced claim skill. Delegates validation to a subagent (elaborate logic), then claims if ready. If the issue isn't ready, blocks it instead of claiming.

## Phase 1 — Validate (subagent)

1. **Launch a general-purpose subagent** (via Task tool, `subagent_type: general-purpose`) with these instructions:

   > Read `.claude/project-context.md` for codebase context. Then run `pnpm gitea issue <id>` and validate the spec:
   >
   > - Check for Acceptance Criteria (REQUIRED), Test Plan (REQUIRED), Implementation Detail (recommended), Dependencies, Scope Boundaries
   > - Explore codebase ONLY for gaps not covered by the context cache
   > - Check overlapping work: `pnpm gitea prs`
   > - Check dependencies: `pnpm gitea issue <dep-id>` for any referenced issues
   > - Fill gaps in issue body (durable content only — missing AC, test plan items, scope boundaries). Write ephemeral findings (file paths, interfaces, wiring points) to your output only.
   > - If filling gaps, update issue body: preserve all existing content, append `## Implementation Notes (auto-generated)`, use `pnpm gitea issue-update <id> body --body-file <temp-file-path>`
   >
   > Return a structured verdict:
   > ```
   > VERDICT: ready | filled | not-ready
   > AC: present | filled | missing
   > Test Plan: present | filled | missing
   > Implementation Detail: present | filled | missing
   > Dependencies: none | met | unmet (<list>)
   > Overlap: none | <PR links>
   > Gaps Filled: <list or "none">
   > Codebase Findings: <compact implementation hints — ephemeral>
   > ```
   > Followed by 2-3 sentences max of prose explanation.

2. **Read the subagent's verdict.**

3. **Gate on readiness:**
   - **`ready` / `filled`** → proceed to Phase 1.5
   - **`not-ready`** →
     - Post a BLOCKED comment on the issue:
       - Write to a temp file, then: `pnpm gitea issue-comment <id> --body-file <temp-file-path>`
       - Comment template:
         ```
         **BLOCKED — spec not ready for implementation**

         Missing:
         - <what's missing or ambiguous>

         Questions:
         1. <Question>?
             - A) ...
             - B) ...
             - Default if no answer: A

         Once resolved, re-run `/claim <id>`.
         ```
       - Clean up the temp file
     - Set `status/blocked` label (replace existing `status/*`, keep all other labels):
       - `pnpm gitea issue-update <id> labels "<labels with status/* replaced by status/blocked>"`
     - **STOP** — report to user what's missing. Do not proceed.

## Phase 1.5 — Auto-promote (if needed)

4. **Check current status label.** If the issue has `status/backlog` (not `status/ready`), auto-promote:
   - Replace `status/backlog` with `status/ready` in the label set
   - Run: `pnpm gitea issue-update <id> labels "<comma-separated>"`
   - This makes Phase 1 the authoritative readiness gate — no manual label flipping needed.

## Phase 2 — Claim (standard mechanics)

5. **Check for existing PRs:**
   - Run `pnpm gitea prs` and check if any open PR title contains `#<id>`.
   - If one exists, STOP: "PR already open for #<id>: <PR link>"

6. **Post a claim comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   pnpm gitea issue-comment <id> --body-file <temp-file-path>
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
   - Codebase findings: <relevant patterns, interfaces, wiring points from subagent verdict>
   ```
   - Clean up the temp file after posting.

7. **Set labels to `status/in-progress` + `stage/dev`** (keeping all other existing labels):
   - From the issue output, extract the current label names.
   - Replace any `status/*` label with `status/in-progress`.
   - Replace any `stage/*` label with `stage/dev` (or add `stage/dev` if none exists).
   - Run: `pnpm gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `status/in-progress` and `stage/dev`. If it doesn't, STOP and report the error.

8. **Create the feature branch:**
   ```bash
   git stash --include-untracked
   git checkout main
   git pull
   ```
   Then check if main is ahead of origin: `git rev-list --count origin/main..main`
   - If count > 0: push first (`git push origin main`). If push fails (diverged), run `git pull --rebase origin main` then push. These unpushed commits will pollute every feature branch if not resolved.
   - If count = 0: proceed.
   ```bash
   git checkout -b feature/issue-<id>-<slug>
   git stash pop
   ```
   where `<slug>` is a short kebab-case summary of the issue title.

   Note: `git stash pop` may silently succeed with no stash if working directory was clean — that's fine.

9. Tell the user the issue is claimed and show the plan, including codebase findings from the validation phase.
