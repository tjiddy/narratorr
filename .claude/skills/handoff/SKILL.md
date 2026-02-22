---
name: handoff
description: Push changes, create a PR, and hand off a Gitea issue. Runs quality
  gates, posts handoff comment, updates labels, and captures learnings. Use when user
  says "hand off", "create PR", "submit for review", or invokes /handoff.
argument-hint: <issue-id>
---

# /handoff <id> — Push, create PR, and hand off a Gitea issue

Automates the "Push + Create PR + Update issue" workflow.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Verify branch:** Run `git branch --show-current`. It must match `feature/issue-<id>-*`. If not, STOP: "Not on the expected feature branch for #<id>."

2. **Run quality gates via subagent** (keeps verbose build output out of main context):
   Launch a **haiku subagent** (Task tool, `subagent_type: "Bash"`, `model: "haiku"`) with these instructions:

   > Run these commands sequentially from the repo root. Use `--no-color` flag where supported. For each command, capture the exit code and extract only failure details (first 3-5 actionable error lines). Stop on first failure — report remaining as `skipped`. Do NOT fix failures — just report them.
   >
   > 1. `pnpm lint` (or project equivalent from CLAUDE.md § Commands)
   > 2. `pnpm test`
   > 3. `pnpm typecheck`
   > 4. `pnpm build`
   >
   > Return ONLY this structured summary (no other output):
   > ```
   > LINT: pass | fail (N errors: <first 3>)
   > TEST: pass (N suites, M tests) | fail (N failed: <test names>)
   > TYPECHECK: pass | fail (<first 5 errors>)
   > BUILD: pass | fail (<error summary>)
   > OVERALL: pass | fail
   > ```

   If OVERALL: fail → STOP and report failures (do NOT fix — that's the caller's job). If pass → continue to step 2b.

2b. **Check for remaining test stubs.**
   Search for `it.todo(` in all test files changed on this branch (use `git diff main --name-only -- '*.test.*'`).
   - If any `it.todo()` calls remain, STOP and report them:
     ```
     TEST STUBS: fail — N unimplemented test stubs remain
     - <file>: "<stub description>"
     - <file>: "<stub description>"
     ```
     These stubs were created from spec interactions during `/claim`. Each one must be implemented as a real test before handoff.
   - If none remain (or no test files changed), continue to step 3.

3. **Push the branch:**
   ```bash
   git push -u origin $(git branch --show-current)
   ```

4. **Read the issue** to get the title and details: `gitea issue $ARGUMENTS`

5. **Create the PR** via the Gitea API:
   - Write the PR body to a temp file (avoids shell escaping issues with multiline content):
   ```bash
   # Write PR body to temp file, then create PR
   gitea pr-create "#<id> <issue title>" --body-file <temp-file-path> "<branch-name>" "main"
   ```
   PR body template (write this to the temp file):
   ```
   Refs #<id>

   ## Summary
   - <bullet points of what changed>

   ## Acceptance Criteria
   - [ ] <from the issue spec>

   ## Tests / Verification
   - Commands: <what was run>
   - Manual: <what was checked>

   ## Risk / Rollback
   - Risk: low — <rationale>
   - Rollback: revert PR
   ```

6. **Update labels to `stage/review`** (keeping all other existing labels):
   - Read the current labels from the issue output (step 4).
   - Replace any `stage/*` label with `stage/review` (keep `status/in-progress` and all other labels).
   - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `stage/review`.

7. **Post a handoff comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **PR ready:** <PR link>

   - What changed:
       - ...
   - How verified:
       - ...
   - Notes / follow-ups:
       - None
   ```
   - Clean up the temp file after posting.

8. **Switch back to main:**
   ```bash
   git checkout main
   ```

9. **Continuous Learning retrospective** — before writing the workflow log, reflect on the implementation:

   a. **Read scratch context:** If `.claude/scratch.md` exists, read it — this contains recent assistant context captured before compaction. Use it as supplementary memory for the retrospective steps below. (If the file doesn't exist, that's fine — proceed without it.)

   b. **Write learning files:** Reflect on the full implementation. Write a learning file to `.claude/learnings/` for EVERY noteworthy item — things that surprised you, patterns that weren't obvious, gotchas you hit, constraints that aren't documented. No cap on count; capture everything worth knowing. Create the directory if it doesn't exist.
      - Filename: `.claude/learnings/<short-slug>.md` (e.g., `fastify-inject-content-type.md`)
      - Format:
        ```yaml
        ---
        scope: [<matching issue scope labels, e.g. frontend, backend, core>]
        files: [<relevant files>]
        issue: <id>
        date: <YYYY-MM-DD>
        ---
        <One or two sentences: what you learned, why it matters, and what would have prevented the friction.>
        ```

   c. **Log debt observations:** If you noticed anything out of scope that needs fixing (bad patterns, missing tests, poor abstractions, confusing naming), append one-liner bullets to `.claude/debt.md`. Create the file with a `# Technical Debt` heading if it doesn't exist. Format: `- **<file or area>**: <what's wrong and why it matters> (discovered in #<id>)`

   d. **Rank top 3:** Ask yourself: "What are 3 things I wish I'd known before starting this issue?" Write these to a `### Wish I'd Known` section in the workflow log entry (step 10). Reference the full learning files from 9b where applicable.

   e. **Delete scratch file:** If `.claude/scratch.md` exists, delete it — it's been consumed.

   f. **Verify capture (HARD GATE):** Before proceeding to step 10, verify:
      - `.claude/learnings/` exists and contains at least one `.md` file with `issue: <id>` in its frontmatter — OR the workflow log entry (step 10) explicitly states under `### Wish I'd Known` why zero learnings were captured (e.g., "Trivial issue with no surprises — no learnings to capture").
      - If debt was discovered during implementation (fix iterations, dead code, out-of-scope issues found while reading code), `.claude/debt.md` exists and contains at least one entry referencing `#<id>`.
      - If either check fails, STOP and complete the missing capture before continuing. Do NOT skip this step — it is the safety net for mid-implementation capture being skipped (which happens reliably).

10. **Prepend to workflow log** (`.claude/workflow-log.md`) — add a new entry at the **top** of the file (below the `# Workflow Log` heading), so entries are reverse-chronological. If the file doesn't exist, create it with the heading first.

   Entry format:
   ```
   ## #<id> <issue title> — <YYYY-MM-DD>
   **Skill path:** /implement → /claim (with elaborate subagent) → /handoff
   **Outcome:** success — PR #<number>

   ### Metrics
   - Files changed: <N> | Tests added/modified: <N>
   - Quality gate runs: <N> (pass on attempt <N>)
   - Fix iterations: <N> (what failed and how it was fixed)
   - Context compactions: <N> (did any cause rework?)

   ### Workflow experience
   - What went smoothly: <what worked well>
   - Friction / issues encountered: <problems hit during implementation — be specific about root causes>

   ### Token efficiency
   - Highest-token actions: <what consumed the most context>
   - Avoidable waste: <what could have been done better>
   - Suggestions: <lessons for next time>

   ### Infrastructure gaps
   - Repeated workarounds: <patterns you worked around more than once, or known workarounds from prior sessions>
   - Missing tooling / config: <things that should exist but don't>
   - Unresolved debt: <tech debt introduced or discovered — things that need future attention>

   ### Wish I'd Known
   1. <most impactful thing you wish you'd known before starting>
   2. <second most impactful>
   3. <third most impactful>
   ```

11. **Update project context cache** (`.claude/project-context.md`) — if the file exists:
    - Read the file, find the `## Recent Changes` section
    - Prepend a new entry at the top of the list: `- PR #<number> — #<id> <issue title>: <2-3 bullet summary of what changed>`
    - If the section has more than 10 entries, remove the oldest ones (bottom of the list)
    - Write the updated file

12. Tell the user the PR is created and show the link.
