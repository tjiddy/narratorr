---
name: merge
description: Merge an approved pull request after verifying approval, quality gates,
  and no unresolved disputes. Use when user says "merge PR", "merge pull request",
  or invokes /merge.
argument-hint: <pr-number>
disable-model-invocation: true
model: sonnet
---

!`cat .claude/docs/workflow.md`

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

4. **Verify CI status:**
   - Extract the head SHA from the PR details (step 1 output, `sha: <value>`)
   - Run `gitea commit-status <sha>` to check the combined CI status
   - If `CI: success` → proceed to merge
   - If `CI: pending` → **STOP**: "CI checks are still running for this PR. Wait for CI to complete and re-run `/merge`."
   - If `CI: failure` or `CI: error` →
     - Find the linked issue from PR body (`Refs #<id>`)
     - Read issue labels: `gitea issue <id>`
     - Replace any `status/*` label with `status/blocked` (keep `stage/*` and all other labels)
     - Run: `gitea issue-update <id> labels "<comma-separated>"`
     - Post a comment: `gitea issue-comment <id> "Merge blocked — CI checks failed on PR #<pr-number>. See commit status for details."`
     - **STOP**: "CI checks failed — issue set to `status/blocked`." Include the per-check status output.
   - If `CI: no status checks found` → check PR comments and conversation for a `/verify` pass (`OVERALL: pass`) posted **after the most recent push** to the PR branch (compare the verify comment's timestamp against the latest commit date on the head branch). If a post-push verify is found, proceed to merge. If not found or the verify predates the latest push, **STOP**: "No CI status checks found and no recent `/verify` pass. Run `/verify` to confirm quality gates before merging."

5. **Merge the PR:**
   - `gitea pr-merge <pr-number>` (defaults to squash — one clean commit on main)
   - If merge succeeds → proceed to step 6
   - If merge fails → inspect the error and route accordingly:

     **Merge conflict** (error contains "conflict", "cannot be merged", "merge conflicts"):
     - Find the linked issue from PR body (`Refs #<id>`)
     - Read issue labels: `gitea issue <id>`
     - Replace any `stage/*` label with `stage/fixes-pr` (keep all other labels)
     - Run: `gitea issue-update <id> labels "<comma-separated>"`
     - Post a comment on the issue: `gitea issue-comment <id> "Merge conflict on PR #<pr-number>. Needs rebase against main before merge."`
     - **STOP**: "Merge conflict — issue set to `stage/fixes-pr` for rebase cycle."

     **CI/pipeline failure** (error contains "status check", "CI", "check failed"):
     - Find the linked issue from PR body (`Refs #<id>`)
     - Read issue labels: `gitea issue <id>`
     - Replace any `status/*` label with `status/blocked` (keep `stage/*` and all other labels)
     - Run: `gitea issue-update <id> labels "<comma-separated>"`
     - Post a comment on the issue: `gitea issue-comment <id> "Merge blocked — CI/pipeline failure on PR #<pr-number>. See PR for details."`
     - **STOP**: "Merge blocked by CI failure — issue set to `status/blocked`."

     **Other failure** (unknown error):
     - Find the linked issue from PR body (`Refs #<id>`)
     - Read issue labels: `gitea issue <id>`
     - Replace any `status/*` label with `status/blocked` (keep `stage/*` and all other labels)
     - Run: `gitea issue-update <id> labels "<comma-separated>"`
     - Post a comment on the issue: `gitea issue-comment <id> "Merge failed on PR #<pr-number> — unknown error. Human intervention needed. Error: <error message>"`
     - **STOP**: "Merge failed — issue set to `status/blocked`. Error: <message>"

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
