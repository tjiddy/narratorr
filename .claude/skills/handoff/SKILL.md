# /handoff <id> — Push, create PR, and hand off a Gitea issue

Automates the "Push + Create PR + Update issue" workflow from `docs/agent_workflow.md`.

## Steps

1. **Verify branch:** Run `git branch --show-current`. It must match `feature/issue-<id>-*`. If not, STOP: "Not on the expected feature branch for #<id>."

2. **Verify build:** Run `pnpm build && pnpm typecheck`. If either fails, STOP: "Build/typecheck failed — fix before handoff."

3. **Push the branch:**
   ```bash
   git push -u origin $(git branch --show-current)
   ```

4. **Read the issue** to get the title and details: `pnpm gitea issue $ARGUMENTS`

5. **Create the PR** via the Gitea API:
   ```bash
   pnpm gitea pr-create "#<id> <issue title>" "<pr body>" "<branch-name>" "main"
   ```
   PR body template:
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
   ```bash
   pnpm gitea issue-comment <id> "<comment>"
   ```
   Comment template:
   ```
   **PR ready:** <PR link>

   - What changed:
       - ...
   - How verified:
       - ...
   - Notes / follow-ups:
       - None
   ```

8. **Switch back to main:**
   ```bash
   git checkout main
   ```

9. **Append to workflow log** (`.claude/workflow-log.md`) using the template from `docs/agent_workflow.md` section 7. Include workflow experience, friction encountered, and token efficiency notes.

10. Tell the user the PR is created and show the link.
