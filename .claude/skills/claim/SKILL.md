# /claim <id> — Claim a Gitea issue and start work

Automates the "Claim & Plan" workflow from `docs/agent_workflow.md`.

## Steps

1. Read the issue: run `pnpm gitea issue $ARGUMENTS` and capture the output.

2. **Verify the issue is claimable:**
   - Label must include `status/ready`. If not, STOP and tell the user: "Issue #<id> is not `status/ready` — cannot claim."
   - Body must contain Acceptance Criteria. If missing, STOP: "Issue #<id> has no Acceptance Criteria."
   - Body must contain a Test Plan. If missing, STOP: "Issue #<id> has no Test Plan."

3. **Check for existing PRs:**
   - Run `pnpm gitea prs` and check if any open PR title contains `#<id>`.
   - If one exists, STOP: "PR already open for #<id>: <PR link>"

4. **Post a claim comment** on the issue using `pnpm gitea issue-comment <id> "<comment>"`.
   Use this template (fill in the plan based on the issue spec):
   ```
   **Claiming #<id>**
   - Plan:
       1. ...
       2. ...
       3. ...
   - Expected changes: `<files/modules>`
   - Verification: `<tests to run>`
   ```

5. **Set labels to `status/in-progress` + `stage/dev`** (keeping all other existing labels):
   - From the issue output, extract the current label names.
   - Replace any `status/*` label with `status/in-progress`.
   - Replace any `stage/*` label with `stage/dev` (or add `stage/dev` if none exists).
   - Run: `pnpm gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `status/in-progress` and `stage/dev`. If it doesn't, STOP and report the error.

6. **Create the feature branch:**
   ```bash
   git checkout main && git pull && git checkout -b feature/issue-<id>-<slug>
   ```
   where `<slug>` is a short kebab-case summary of the issue title.

7. **Read the full workflow reference:** Read `docs/agent_workflow.md` so you have the complete workflow context for implementation and handoff.

8. Tell the user the issue is claimed and show the plan.
