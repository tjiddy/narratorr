---
name: resume
description: Resume a previously blocked Gitea issue by restoring the branch and
  working state. Use when user says "resume issue", "unblock", or invokes /resume.
argument-hint: <issue-id>
---

# /resume <id> — Resume a blocked issue

Run: `node scripts/resume.ts $ARGUMENTS`

The script handles: verifying blocked status, finding/creating the branch, updating labels, and posting a resume comment.

Its output includes:
- `RESUMED: #<id> — <branch>` (success line)
- The original blocker context
- Any answers posted after the blocker (or "No answers posted yet")

Display this to the user and wait for their confirmation before continuing implementation.
