---
name: merge
description: Merge an approved pull request after verifying approval, quality gates,
  and no unresolved disputes. Use when user says "merge PR", "merge pull request",
  or invokes /merge.
argument-hint: <pr-number>
disable-model-invocation: true
---

# /merge <pr-number> — Merge an approved pull request

Run: `node scripts/merge.ts $ARGUMENTS`

Display the output to the user.

On success: `MERGED: PR #<n> — #<id> closed`.
On failure: error with details (no approval, CI failed, merge conflict, etc.).

The script handles approval validation, CI checks, merge execution, local cleanup, and issue label/state updates.
