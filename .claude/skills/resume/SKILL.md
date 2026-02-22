# /resume <id> — Resume a blocked issue

Picks up a previously blocked issue by finding the blocker context, checking for answers, and restoring the working state.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue $ARGUMENTS`. Verify it has `status/blocked` label. If not, STOP: "Issue #<id> is not blocked — nothing to resume."

2. **Find the blocker context:**
   - The issue comments should contain a `**BLOCKED` marker (posted by `/block` or `/claim`)
   - Read comments to find the most recent BLOCKED comment
   - Extract: what was missing, what questions were asked

3. **Check for answers:**
   - Read all comments posted AFTER the BLOCKED comment
   - Look for answers to the questions raised in the blocker
   - If no answers found, report to user: "No answers to blocking questions yet. Questions were: <list>"
   - If answers found, extract and summarize them

4. **Restore working state:**
   - Find the existing feature branch: `git branch --list "feature/issue-$ARGUMENTS-*"`
   - If found, check it out: `git checkout <branch-name>`
   - If not found, create one: `git checkout main && git pull && git checkout -b feature/issue-<id>-<slug>`

5. **Update labels:** Replace `status/blocked` with `status/in-progress` (keep all other labels):
   - Extract current labels from issue output
   - Replace `status/blocked` with `status/in-progress`
   - Ensure `stage/dev` is present
   - Run: `gitea issue-update <id> labels "<comma-separated>"`

6. **Post resume comment** on the issue:
   - Write to temp file, then: `gitea issue-comment <id> --body-file <temp-file-path>`
   - Template:
     ```
     **Resuming #<id>**
     - Previous blocker: <summary>
     - Resolution: <answers found or "proceeding with default approach">
     - Branch: <branch-name>
     ```
   - Clean up temp file

7. **Report to user:**
   - Show blocker summary, answers found, current branch
   - Wait for user confirmation before continuing implementation

## Important

- This skill only resumes — it does NOT implement. After resuming, the user decides next steps
- If the issue has no BLOCKED comment, STOP — something is wrong with the workflow state
- If no feature branch exists, that's OK — create a fresh one
