---
name: plan
description: JIT elaboration for a claimed issue — explores the codebase, extracts
  test stubs, and posts a structured implementation plan. Use when user says "plan
  issue", "explore for issue", or invokes /plan.
argument-hint: <issue-id>
---

# /plan <id> — JIT elaboration and implementation planning

Explores the codebase, extracts test stubs from the spec, and posts a structured implementation plan on the issue. Run after `/claim` creates the branch, before writing any code.

**Prerequisite:** Issue must be `status/in-progress` with a feature branch checked out.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue <id>`. Extract title, labels, body, and comments.

2. **Extract reviewer suggestions from approval:**
   - From the issue comments, find the most recent `## Spec Review` comment with `## Verdict: approve`
   - If it has a `## Findings` JSON block with `suggestion` severity findings, extract them — these are refinements the reviewer identified that should be incorporated during implementation
   - Carry these forward to include in the plan comment (step 5)
   - If no approval comment or no suggestions, skip this step

3. **Explore the codebase** via an Explore subagent (keeps file reads out of main context):

   Launch an **Explore subagent** (Agent tool, `subagent_type: "Explore"`) with this prompt:

   > Explore the codebase for implementation planning of issue #<id>: "<issue title>".
   > Scope labels: <labels>. Key areas from spec: <summarize relevant AC and implementation hints>.
   >
   > Do the following and return a structured summary:
   > 1. Read `CLAUDE.md` for design principles and conventions
   > 2. Find files/modules relevant to the issue scope — existing patterns, interfaces, wiring points
   > 3. Check for overlapping work: run `node scripts/gitea.ts prs` and look for PRs touching the same area
   > 4. Check dependencies: run `node scripts/gitea.ts issue <dep-id>` for any referenced issues to verify status
   > 5. Scan `.claude/learnings/` for files whose `scope` or `files` frontmatter matches this issue's labels or target files
   > 6. Check `.claude/debt.md` for items in the target area
   >
   > Return this structure:
   > ```
   > PATTERNS: <relevant existing patterns and interfaces found>
   > WIRING POINTS: <files that need modification to wire the feature>
   > OVERLAPPING WORK: <open PRs in the same area, or "none">
   > DEPENDENCIES: <dep status, or "none">
   > KNOWN LEARNINGS: <relevant learnings from .claude/learnings/ and debt items, or "none">
   > DESIGN CONCERNS: <any SRP/DRY/Open-Closed issues the implementation should watch for>
   > ```

   Use the subagent's structured output directly in the plan comment (step 5).

4. **Extract test stubs from spec (if present).**
   Scan the issue body for `## User Interactions`, `## System Behaviors`, and `## Edge Cases (auto-generated)` sections (or equivalent interaction-style requirements like "user does X → Y" / "when X → Y" anywhere in the spec):

   **For User Interactions** (frontend):
   - Create `it.todo('description')` stubs in co-located test files next to the planned frontend files (e.g., `ManualImportPage.tsx` → `ManualImportPage.test.tsx`)

   **For System Behaviors** (backend/core):
   - Create `it.todo('description')` stubs in co-located test files next to the planned service/route/utility files (e.g., `match-job.service.ts` → `match-job.service.test.ts`)

   **For both:**
   - Group stubs by component/module using `describe()` blocks
   - Each stub should map to one interaction or behavior from the spec
   - If test files already exist, append new `describe`/`it.todo` blocks — don't overwrite existing tests
   - If test files don't exist yet, create them with the standard imports (`describe`, `it`, `vi` from `vitest`) and leave the actual test setup (mocks, render helpers) for the implementer
   - If neither spec section exists, skip this step (older issues won't have it)

   Example — given a spec interaction "User clicks 'Cancel' → modal closes":
   ```ts
   describe('MyComponent', () => {
     it.todo('closes modal when user clicks Cancel');
   });
   ```

   These stubs are the **minimum test coverage** — every spec interaction and system behavior must have a corresponding test. The implementer should add additional tests beyond these stubs for edge cases, error states, and implementation details discovered during development. The stubs are a floor, not a ceiling.

5. **Post a plan comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **Implementation plan for #<id>**
   - Plan:
       1. ...
       2. ...
       3. ...
   - Expected changes: `<files/modules>`
   - Verification: `<tests to run>`
   - Codebase findings: <relevant patterns, interfaces, wiring points>
   - Known learnings: <relevant learnings from `.claude/learnings/` and `.claude/debt.md`, or "none">
   - Reviewer suggestions: <suggestion findings from the approval comment (step 2), or "none">
   - Design checklist:
       - [ ] Each new file has a single responsibility
       - [ ] No duplicated patterns — reuses existing hooks/components or extracts shared ones
       - [ ] Wiring touches ≤3 existing files (new features extend, not modify)
       - [ ] Types and components co-located with their domain
   ```
   If any design check fails, note the mitigation.
   - Clean up the temp file after posting.

6. Tell the user the plan is posted and show the summary, including codebase findings from step 3.

## Important

- This skill does NOT claim the issue or create branches — that's `/claim`'s job
- This skill does NOT implement anything — it plans and writes test stubs
- The plan comment and test stubs are the handoff from planning to implementation
- When called inside `/implement`, the output feeds directly into the implementation phase
