# /block <id> — Mark a Gitea issue as blocked

Automates the "BLOCKED" workflow.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue $ARGUMENTS` to get current labels and context.

2. **Ask the user** what the blocker is. Gather:
   - Context: what was attempted and where you got stuck
   - Questions that need answering (with options and defaults)

3. **Post a BLOCKED comment** on the issue:
   - Write the comment to a temp file, then post it (avoids shell truncation of multiline strings):
   ```bash
   gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **BLOCKED — need input**

   Context: <1-2 sentences>

   Decision needed:
   1. <Question>?
       - A) ...
       - B) ...
       - Default if no answer: A

   Once answered, I will: <1 sentence>
   ```
   - Clean up the temp file after posting.

4. **Set labels to `status/blocked`** (keeping other labels, including current `stage/*`):
   - From the issue output, extract the current label names.
   - Replace any `status/*` label with `status/blocked`.
   - Keep the current `stage/*` label as-is (it indicates where to resume when unblocked).
   - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `status/blocked`.

5. **STOP** — tell the user the issue is blocked and do not continue implementation.
