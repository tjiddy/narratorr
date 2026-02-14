# /elaborate <id> — Groom and validate a Gitea issue (no side effects)

Standalone grooming/triage skill. Reads the issue, uses the project context cache, explores the codebase only for gaps, checks dependencies, and reports a structured readiness verdict. **Does NOT change labels, create branches, or post comments** unless updating the issue body with missing details found from codebase exploration.

## Steps

0. **Read the project context cache:** Read `.claude/project-context.md` to understand current codebase state (interfaces, patterns, wiring, schema). Only explore the codebase further for information NOT covered by the cache.

1. **Read the issue:** Run `pnpm gitea issue $ARGUMENTS` and capture the full output (title, body, labels, milestone).

2. **Parse spec completeness.** Check the issue body for:
   - **Acceptance Criteria** — clear, testable statements (REQUIRED)
   - **Test Plan** — specific test cases or commands (REQUIRED)
   - **Implementation detail** — file paths, service/route names, enough to start coding (recommended)
   - **Dependencies** — references to other issues (check their status)
   - **Scope boundaries** — what's explicitly out of scope (recommended)

3. **Explore the codebase for gaps not covered by context cache:**
   - Only explore if the context cache doesn't have the needed info
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

6. **Fill gaps — durable content only:**
   - Split findings into two channels:
     - **Durable** (written to issue body): Missing AC items, test plan items, scope boundaries inferred from codebase
     - **Ephemeral** (kept in verdict output only, NOT written to issue): File paths, interface signatures, wiring points, similar feature references
   - If durable content was found, update the issue body:
     - Preserve ALL existing content
     - Append new sections (e.g., `## Implementation Notes (auto-generated)`)
     - Write updated body to a temp file, then: `pnpm gitea issue-update <id> body --body-file <temp-file-path>`
     - Clean up the temp file
   - Only update the body if you're adding genuinely useful durable detail — don't pad it

7. **Report structured readiness verdict.** Use this format:

   ```
   VERDICT: ready | filled | not-ready
   AC: present | filled | missing
   Test Plan: present | filled | missing
   Implementation Detail: present | filled | missing
   Dependencies: none | met | unmet (<list>)
   Overlap: none | <PR links>
   Gaps Filled: <list or "none">
   Codebase Findings: <compact implementation hints — ephemeral>
   ```

   Followed by a brief prose explanation (2-3 sentences max) of the verdict.

## Important

- This skill is **read-only** by default (labels, branches, comments are untouched)
- The ONLY write action is updating the issue body (step 6), and only for durable content
- Do NOT post comments, change labels, or create branches — that's `/claim`'s job
- Do NOT suggest claiming or starting implementation — just report readiness
- Ephemeral codebase findings stay in the verdict output — they're consumed by `/claim` or the user, not persisted to the issue
