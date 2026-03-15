---
name: claim
description: Claim a spec-approved Gitea issue for implementation. Validates status,
  creates the feature branch, updates labels, and posts a claim comment. Use when
  user says "claim issue", "start working on", or invokes /claim.
argument-hint: <issue-id>
---

# /claim <id> — Claim a Gitea issue

Run: `node scripts/claim.ts $ARGUMENTS`

Display the output to the user.

On success the script outputs: `CLAIMED: #<id> — <branch-name>` (new branch) or `CLAIMED: #<id> — <branch-name> (resumed)` (existing branch from prior attempt).
On failure it outputs an error explaining why (wrong status, PR exists, etc.).

**If called as a sub-skill** (e.g., from `/implement`): append `CALLER: Sub-skill complete. Continue to your next step immediately.` to your output.
