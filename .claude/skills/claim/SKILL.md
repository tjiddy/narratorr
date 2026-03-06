---
name: claim
description: Claim a spec-approved Gitea issue for implementation. Validates status,
  creates the feature branch, updates labels, and posts a claim comment. Use when
  user says "claim issue", "start working on", or invokes /claim.
argument-hint: <issue-id>
---

# /claim <id> — Claim a Gitea issue

Mechanical claiming action: validates the issue is ready, creates the feature branch, updates labels, and posts a claim comment. No codebase exploration or planning — that's `/plan`'s job.

**Prerequisite:** The issue must have `status/ready` (set by `/review-spec` on approval). Issues still in `status/backlog` must go through `/review-spec` first.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue <id>`. Extract title, labels, body, and comments.

2. **Check status label:**
   - **`status/ready`** → proceed to step 3
   - **`status/backlog`** →
     - Check if the issue has any `## Spec Review` comments (from `/review-spec`)
     - If it has spec review comments with `needs-work` verdict: STOP — "Issue #<id> has unresolved spec review findings. Update the spec to address findings, then re-run `/review-spec <id>`."
     - If it has no spec review comments: STOP — "Issue #<id> hasn't been through spec review yet. Run `/review-spec <id>` first."
   - **`status/in-progress`** → STOP — "Issue #<id> is already in progress."
   - **`status/blocked`** → STOP — "Issue #<id> is blocked. Check issue comments for details, or run `/resume <id>`."

3. **Check for existing PRs:**
   - Run `gitea prs` and check if any open PR title contains `#<id>`.
   - If one exists, STOP: "PR already open for #<id>: <PR link>"

4. **Create the feature branch:**
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

5. **Set labels to `status/in-progress` + `stage/dev`** (keeping all other existing labels):
   - From the issue output, extract the current label names.
   - Replace any `status/*` label with `status/in-progress`.
   - Replace any `stage/*` label with `stage/dev` (or add `stage/dev` if none exists).
   - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `status/in-progress` and `stage/dev`. If it doesn't, STOP and report the error.

6. **Post a claim comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **Claiming #<id>** — branch: `<branch-name>`
   ```
   - Clean up the temp file after posting.

7. Tell the user the issue is claimed: "**#<id> claimed** — on branch `<branch-name>`. Run `/plan <id>` for implementation planning, or start coding."
