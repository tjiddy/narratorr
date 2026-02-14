# /handoff <id> — Push, create PR, and hand off a Gitea issue

Automates the "Push + Create PR + Update issue" workflow from `docs/agent_workflow.md`.

## Steps

1. **Verify branch:** Run `git branch --show-current`. It must match `feature/issue-<id>-*`. If not, STOP: "Not on the expected feature branch for #<id>."

2. **Verify quality gates:** Invoke `/verify` via the Skill tool. If OVERALL: fail → STOP and report failures. If pass → proceed.

3. **Push the branch:**
   ```bash
   git push -u origin $(git branch --show-current)
   ```

4. **Read the issue** to get the title and details: `pnpm gitea issue $ARGUMENTS`

5. **Create the PR** via the Gitea API:
   - Write the PR body to a temp file (avoids shell escaping issues with multiline content):
   ```bash
   # Write PR body to temp file, then create PR
   pnpm gitea pr-create "#<id> <issue title>" --body-file <temp-file-path> "<branch-name>" "main"
   ```
   PR body template (write this to the temp file):
   ```
   Refs #<id>

   ## Summary
   - <bullet points of what changed>

   ## Acceptance Criteria
   - [ ] <from the issue spec>

   ## Tests / Verification
   - Commands: <what was run>
   - Manual: <what was checked>

   ## Risk / Rollback
   - Risk: low — <rationale>
   - Rollback: revert PR
   ```

6. **Update labels to `stage/review`** (keeping all other existing labels):
   - Read the current labels from the issue output (step 4).
   - Replace any `stage/*` label with `stage/review` (keep `status/in-progress` and all other labels).
   - Run: `pnpm gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `stage/review`.

7. **Post a handoff comment** on the issue:
   - Write the comment to a temp file, then post it (avoids shell truncation of multiline strings):
   ```bash
   pnpm gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **PR ready:** <PR link>

   - What changed:
       - ...
   - How verified:
       - ...
   - Notes / follow-ups:
       - None
   ```
   - Clean up the temp file after posting.

8. **Switch back to main:**
   ```bash
   git checkout main
   ```

9. **Append to workflow log** (`.claude/workflow-log.md`) using the template from `docs/agent_workflow.md` section 7. Include workflow experience, friction encountered, and token efficiency notes.

10. **Update project context cache** (`.claude/project-context.md`):
    - Read the file, find the `## Recent Changes` section
    - Prepend a new entry at the top of the list: `- PR #<number> — #<id> <issue title>: <2-3 bullet summary of what changed>`
    - If the section has more than 10 entries, remove the oldest ones (bottom of the list)
    - Write the updated file

11. Tell the user the PR is created and show the link.
