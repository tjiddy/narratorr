# /claim <id> — Validate and claim a Gitea issue

Enhanced claim skill with built-in validation. Runs elaborate logic inline (spec completeness, codebase exploration, dependency checks) as a gate before claiming. If the issue isn't ready, blocks it instead of claiming.

## Phase 1 — Validate (elaborate logic, inline)

1. **Read the issue:** Run `pnpm gitea issue $ARGUMENTS` and capture the full output.

2. **Parse spec completeness.** Check the issue body for:
   - **Acceptance Criteria** — clear, testable statements (REQUIRED)
   - **Test Plan** — specific test cases or commands (REQUIRED)
   - **Implementation detail** — file paths, service/route names, enough to start coding (recommended)
   - **Dependencies** — references to other issues (check their status)
   - **Scope boundaries** — what's explicitly out of scope (recommended)

3. **Explore the codebase for relevant patterns:**
   - Find similar existing features (e.g., if adding a new adapter, look at existing adapters)
   - Check interfaces/types in `packages/core/src/*/types.ts`, `shared/schemas.ts`, `packages/db/src/schema.ts`
   - Identify touch points — wiring files like `routes/index.ts`, `services/`, `App.tsx`, `Layout.tsx`
   - Note naming conventions, folder structure, and test patterns used by similar features

4. **Check for overlapping work:**
   - Run `pnpm gitea prs` — any open PR touching the same area?
   - Any `status/in-progress` issues that overlap in scope?

5. **Check dependencies:**
   - If the issue references other issues (e.g., "depends on #X"), verify those are `status/done`

6. **Fill gaps from codebase knowledge (if possible):**
   - If implementation detail is missing but can be inferred from codebase exploration, update the issue body:
     - Preserve ALL existing content
     - Append new sections (e.g., `## Implementation Notes (auto-generated)`)
     - Write updated body to a temp file, then: `pnpm gitea issue-update <id> body --body-file <temp-file-path>`
     - Clean up the temp file

7. **Gate on readiness:**
   - **Ready / Filled** → proceed to Phase 2
   - **Not ready** (ambiguous requirements, missing AC/test plan, unresolved deps, needs human input) →
     - Post a BLOCKED comment on the issue:
       - Write to a temp file, then: `pnpm gitea issue-comment <id> --body-file <temp-file-path>`
       - Comment template:
         ```
         **BLOCKED — spec not ready for implementation**

         Missing:
         - <what's missing or ambiguous>

         Questions:
         1. <Question>?
             - A) ...
             - B) ...
             - Default if no answer: A

         Once resolved, re-run `/claim <id>`.
         ```
       - Clean up the temp file
     - Set `status/blocked` label (replace existing `status/*`, keep all other labels):
       - `pnpm gitea issue-update <id> labels "<labels with status/* replaced by status/blocked>"`
     - **STOP** — report to user what's missing. Do not proceed to Phase 2.

## Phase 2 — Claim (standard mechanics)

8. **Verify `status/ready` label.** If not present, STOP: "Issue #<id> is not `status/ready` — cannot claim."

9. **Check for existing PRs:**
   - Run `pnpm gitea prs` and check if any open PR title contains `#<id>`.
   - If one exists, STOP: "PR already open for #<id>: <PR link>"

10. **Post a claim comment** on the issue:
    - Write the comment to a temp file, then post it:
    ```bash
    pnpm gitea issue-comment <id> --body-file <temp-file-path>
    ```
    Comment template (write this to the temp file):
    ```
    **Claiming #<id>**
    - Plan:
        1. ...
        2. ...
        3. ...
    - Expected changes: `<files/modules>`
    - Verification: `<tests to run>`
    - Codebase findings: <relevant patterns, interfaces, wiring points found during validation>
    ```
    - Clean up the temp file after posting.

11. **Set labels to `status/in-progress` + `stage/dev`** (keeping all other existing labels):
    - From the issue output, extract the current label names.
    - Replace any `status/*` label with `status/in-progress`.
    - Replace any `stage/*` label with `stage/dev` (or add `stage/dev` if none exists).
    - Run: `pnpm gitea issue-update <id> labels "<comma-separated label names>"`
    - Verify the output shows `status/in-progress` and `stage/dev`. If it doesn't, STOP and report the error.

12. **Create the feature branch:**
    ```bash
    git checkout main && git pull && git checkout -b feature/issue-<id>-<slug>
    ```
    where `<slug>` is a short kebab-case summary of the issue title.

13. **Read the full workflow reference:** Read `docs/agent_workflow.md` so you have the complete workflow context for implementation and handoff.

14. Tell the user the issue is claimed and show the plan, including codebase findings from the validation phase.
