# /elaborate <id> — Groom and validate a Gitea issue (no side effects)

Standalone grooming/triage skill. Reads the issue, explores the codebase for relevant patterns, checks dependencies, and reports a readiness verdict. **Does NOT change labels, create branches, or post comments** unless updating the issue body with missing details found from codebase exploration.

## Steps

1. **Read the issue:** Run `pnpm gitea issue $ARGUMENTS` and capture the full output (title, body, labels, milestone).

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
   - Run `pnpm gitea issue <dep-id>` for each dependency to check status

6. **Fill gaps from codebase knowledge (if possible):**
   - If implementation detail is missing but can be inferred from codebase exploration (file paths, interface signatures, wiring points), update the issue body:
     - Preserve ALL existing content
     - Append new sections (e.g., `## Implementation Notes (auto-generated)`)
     - Write updated body to a temp file, then: `pnpm gitea issue-update <id> body --body-file <temp-file-path>`
     - Clean up the temp file
   - Only update the body if you're adding genuinely useful detail — don't pad it

7. **Report readiness verdict to the user.** One of three outcomes:

   - **Ready** — AC testable, test plan specific, implementation path clear, no blockers. Report what you found in the codebase and suggest an implementation approach.
   - **Needs detail (filled)** — Had gaps, filled from codebase knowledge, now ready. Report what was added and why.
   - **Not ready** — Ambiguous requirements, missing AC/test plan, unresolved dependencies, or needs human input. Report exactly what's missing and what questions need answers.

## Important

- This skill is **read-only** by default (labels, branches, comments are untouched)
- The ONLY write action is updating the issue body (step 6), and only when gaps can be filled from codebase knowledge
- Do NOT post comments, change labels, or create branches — that's `/claim`'s job
- Do NOT suggest claiming or starting implementation — just report readiness
