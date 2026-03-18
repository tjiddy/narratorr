---
name: block
description: Mark a Gitea issue as blocked. Use when user says "block issue", "mark
  blocked", or invokes /block.
argument-hint: <issue-id>
---

# /block <id> — Mark a Gitea issue as blocked

1. **If the user hasn't stated the blocker reason yet**, ask what the blocker is. Gather:
   - Context: what was attempted and where you got stuck
   - Questions that need answering (with options and defaults)

2. **Once you have the reason**, format it as a clear blocker description and run:
   ```
   node scripts/block.ts <id> "<reason>"
   ```

3. Display the output and **STOP** — do not continue implementation.

On success the script outputs: `BLOCKED: #<id>`.
It handles posting the BLOCKED comment and updating labels.
