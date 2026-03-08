---
name: elaborate
description: Groom and validate a Gitea issue spec. Checks completeness, explores
  the codebase for gaps, and reports a structured readiness verdict. Use when user
  says "elaborate", "groom issue", or invokes /elaborate.
argument-hint: <issue-id>
---

# /elaborate <id> — Groom and validate a Gitea issue spec

Standalone grooming/triage skill. Reads the issue, explores the codebase for gaps, checks dependencies, and reports a structured readiness verdict. Read-only except for updating the issue body with durable content (missing AC, test plan items, scope boundaries).

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue $ARGUMENTS` and capture the full output (title, body, labels, milestone).

1b. **Check for spec review findings:** Run `gitea issue-comments <id>`. Look for the most recent comment containing `## Spec Review` and `## Verdict:`. If found and the verdict is `needs-work`, **STOP**: "Issue #<id> has unresolved spec review findings. Run `/respond-to-spec-review <id>` to address them." If the verdict is `approve` or no review comment exists, continue with step 2.

2. **Parse spec completeness.** Check the issue body for:
   - **Acceptance Criteria** — clear, testable statements (REQUIRED)
   - **Test Plan** — specific test cases or commands (REQUIRED)
   - **Implementation detail** — file paths, service/route names, enough to start coding (recommended)
   - **Dependencies** — references to other issues (check their status)
   - **Scope boundaries** — what's explicitly out of scope (recommended)

3. **Explore codebase, history, and dependencies** via an Explore subagent (keeps verbose file reads out of main context):

   Launch an **Explore subagent** (Agent tool, `subagent_type: "Explore"`, thoroughness: "very thorough") with this prompt:

   > Explore the codebase to validate issue #<id>: "<issue title>".
   > Issue scope: <labels>. Key areas from spec: <summarize AC and implementation hints>.
   >
   > Do ALL of the following and return a structured summary:
   >
   > **Workflow history:**
   > 1. Read `.claude/cl/workflow-log.md` — find entries touching the same area (matching file paths, service names, feature names). Note recurring workarounds, fix iterations, infrastructure gaps.
   > 2. Read `.claude/cl/observations.md` — look for known debt, gotchas, or patterns relevant to the scope.
   > 3. Scan `.claude/cl/learnings/` — grep learning files by scope tags and file paths matching the issue's area.
   > 4. Read `.claude/cl/debt.md` — check for known debt items in the target area.
   >
   > **Codebase exploration:**
   > 5. Find similar existing features (e.g., if adding a new adapter, look at existing adapters)
   > 6. Check interfaces/types relevant to the issue
   > 7. Identify touch points — wiring files, registries, route registrations
   > 8. Note naming conventions, folder structure, and test patterns used by similar features
   >
   > **Deep source analysis for test plan (CRITICAL — read actual source, not just signatures):**
   > 9. For every service/util/route the issue will modify or call, READ THE FULL SOURCE and identify:
   >    - Null/zero/undefined guards and what happens when they trigger (e.g., returns null, throws, skips)
   >    - Division, ratio, or threshold calculations and their boundary behavior
   >    - Optional fields on interfaces that callers may or may not provide
   >    - Falsy coercion gotchas (e.g., `value || fallback` where `value=0` is valid but falsy)
   >    - Protocol/type-specific logic (e.g., filters that apply to torrent but not usenet)
   >    - Transient vs persisted fields (flags that trigger actions but aren't stored in DB)
   >    - Fire-and-forget patterns where failure must not break the parent operation
   >    - Race conditions: data read in one step, used in a later step where it may have changed
   > 10. For each finding, note the specific file, line range, and the test scenario it implies
   >
   > Include a new section in the return structure:
   > ```
   > DEFECT VECTORS: <list of specific edge cases found by reading source, with file:line references and implied test scenarios>
   > ```
   >
   > **Overlap and dependencies:**
   > 11. Run `node scripts/gitea.ts prs` — any open PR touching the same area?
   > 12. Check for `status/in-progress` issues that overlap in scope
   > 13. For any issues referenced as dependencies (e.g., "depends on #X"), run `node scripts/gitea.ts issue <dep-id>` to verify status
   >
   > Return this structure:
   > ```
   > IMPLEMENTATION HAZARDS: <relevant workflow-log/learnings/debt findings, or "none">
   > SIMILAR FEATURES: <existing patterns to follow>
   > INTERFACES & TYPES: <relevant interfaces the implementation will use/extend>
   > TOUCH POINTS: <wiring files, registries, route registrations>
   > CONVENTIONS: <naming, folder structure, test patterns>
   > OVERLAPPING WORK: <open PRs or in-progress issues in the same area, or "none">
   > DEPENDENCIES: <dep status, or "none">
   > ```

   Use the subagent's structured output directly in the verdict (step 5) and gap-filling (step 4).

4. **Fill gaps — durable content only:**
   - Split findings into two channels:
     - **Durable** (written to issue body): Missing AC items, test plan items, scope boundaries inferred from codebase
     - **Ephemeral** (kept in verdict output only, NOT written to issue): File paths, interface signatures, wiring points, similar feature references
   - **Test plan gap-fill is mandatory.** If the test plan is missing or incomplete, build one using:
     - The DEFECT VECTORS from the subagent's source analysis (each vector → one or more test cases)
     - The test plan completeness standard from CLAUDE.md (schema validation, boundary values, null/missing data, filter interactions, error isolation, transient vs persisted, race conditions, end-to-end flows)
     - Test cases should be specific and actionable (e.g., "Results with estimated MB/hr at exactly the grab floor are included" not "test grab floor")
   - If durable content was found, update the issue body:
     - Preserve ALL existing content
     - Append new sections (e.g., `## Implementation Notes (auto-generated)`)
     - Write updated body to a temp file, then: `gitea issue-update <id> body --body-file <temp-file-path>`
     - Clean up the temp file
   - Only update the body if you're adding genuinely useful durable detail — don't pad it

5. **Report structured readiness verdict.** Use this format:

   ```
   VERDICT: ready | filled | not-ready
   AC: present | filled | missing
   Test Plan: present | filled | missing
   Implementation Detail: present | filled | missing
   Dependencies: none | met | unmet (<list>)
   Overlap: none | <PR links>
   Gaps Filled: <list or "none">
   Implementation Hazards: <relevant workflow-log/observations findings or "none">
   Codebase Findings: <compact implementation hints — ephemeral>
   ```

   Followed by a brief prose explanation (2-3 sentences max) of the verdict.

6. **Update labels based on verdict** (for `yolo`-tagged issues):
   - If the issue has the `yolo` label AND verdict is `ready` or `filled`:
     - Replace any `status/*` label with `status/review-spec` (preserve `yolo` and all other labels)
     - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - If the issue has the `yolo` label AND verdict is `not-ready`:
     - Post a comment explaining why: `gitea issue-comment <id> "**BLOCKED — elaboration verdict: not-ready**\n\nContext: <1-2 sentences about what's missing or unresolvable>\n\nNeeded: <what must be fixed before this can proceed>"`
     - Replace any `status/*` label with `status/blocked`
     - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - If the issue does NOT have `yolo`: do not change labels (manual workflow — `/claim` handles labels)

## Important

- This skill is read-only except for updating the issue body (step 4) with durable content and labels (step 6) for yolo-tagged issues
- Do NOT create branches — that's `/claim`'s job
- Do NOT suggest claiming or starting implementation — just report readiness
- Ephemeral codebase findings stay in the verdict output — they're consumed by `/claim` or the user, not persisted to the issue
