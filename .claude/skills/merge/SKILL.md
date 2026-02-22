---
name: merge
description: Merge an approved pull request after verifying approval, quality gates,
  and no unresolved disputes. Use when user says "merge PR", "merge pull request",
  or invokes /merge.
argument-hint: <pr-number>
disable-model-invocation: true
---

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
   - If `CI: failure` or `CI: error` → **STOP**: "CI checks failed. Fix the failures, push, and re-run `/merge`." Include the per-check status output.
   - If `CI: no status checks found` → **STOP**: "No CI status checks found for this PR. Either CI hasn't run or isn't configured for this branch. Run `/verify` manually or push to trigger CI."

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
