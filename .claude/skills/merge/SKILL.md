# /merge <pr-number> — Merge an approved pull request

Merges a PR after verifying it has been approved, quality gates pass, and there are no unresolved disputes.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Fetch PR details:**
   - Run `gitea pr <pr-number>` to get state, head branch, **author** (`author: <login>` in output), linked issue (`Refs #<id>`)
   - If PR is not open, report error and stop

2. **Check approval status:**
   - Run `gitea pr-comments <pr-number>`
   - Find the **most recent** comment containing `## Verdict:`
   - **Author validation:** Check the username on the verdict comment (shown as `--- comment <id> | <username> | <date> ---`). The verdict poster MUST be a **different user** than the PR author from step 1. If the verdict was posted by the same user as the PR author, **ignore it** and look for the next most recent verdict from a different user. If no valid verdict exists, STOP: "No reviewer verdict found. All verdicts were posted by the PR author (`<username>`). The PR needs a review from a different Gitea user."
   - Must be `## Verdict: approve` — if the most recent valid verdict is `needs-work`, stop and report
   - A `needs-work` posted after an `approve` invalidates the approval (stale approval prevention)

3. **Check for unresolved disputes:**
   - Scan comments for any `## Status: needs-human-input` that hasn't been followed by a new review cycle
   - If unresolved disputes exist, stop and report — human must weigh in first

4. **Verify quality gates:**
   - Check if a recent `/verify` run passed (look for verify output in recent comments or conversation)
   - If no recent verification, launch a **haiku subagent** (Task tool, `subagent_type: "Bash"`, `model: "haiku"`) to run gates:

     > Run these commands sequentially from the repo root. Use `--no-color` flag where supported. For each command, capture the exit code and extract only failure details (first 3-5 actionable error lines). Stop on first failure — report remaining as `skipped`.
     >
     > 1. `pnpm lint`
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

   - All gates must pass. If OVERALL: fail → stop and report

5. **Merge the PR:**
   - `gitea pr-merge <pr-number>` (defaults to squash — one clean commit on main)
   - If merge fails (conflicts, etc.), report error and stop

6. **Update local repository:**
   ```bash
   git checkout main
   git pull origin main
   git branch -d <head-branch>
   ```
   - Use `-d` (not `-D`) — if the branch isn't fully merged, something went wrong

7. **Update issue status:**
   - Find linked issue from PR body (`Refs #<id>`)
   - Update labels: `gitea issue-update <id> labels "status/done,<type-label>,<priority-label>,<scope-labels>"`
     - Remove any `stage/*` labels
     - Keep `type/*`, `priority/*`, `scope/*` labels
   - Close issue if not auto-closed: `gitea issue-update <id> state closed`

8. **Report to main agent:** Merge successful, issue closed, branch cleaned up.

## Important

- This skill can be run by the reviewer agent after posting an `approve` verdict, or by a human
- Squash is the default merge method — agent commits during review cycles are noise on main
- Override with `pr-merge <number> merge` or `pr-merge <number> rebase` if needed
- The most recent verdict wins — always check the latest `## Verdict:` comment, not the first one
- Do NOT merge if there are unresolved `needs-human-input` disputes
- If the linked issue is auto-closed by Gitea (via `Refs #N` / `Fixes #N`), the label update still runs but `state closed` is a no-op
