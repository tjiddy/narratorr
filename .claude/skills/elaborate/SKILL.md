---
name: elaborate
description: Groom and validate a GitHub issue spec. Checks completeness, explores
  the codebase for gaps, and reports a structured readiness verdict. Use when user
  says "elaborate", "groom issue", or invokes /elaborate.
argument-hint: <issue-id>
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/architecture-checks.md`

# /elaborate <id> — Groom and validate a GitHub issue spec

Standalone grooming/triage skill. Reads the issue, explores the codebase for gaps, checks dependencies, and reports a structured readiness verdict. Read-only except for updating the issue body with durable content (missing AC, test plan items, scope boundaries).

## GitHub CLI

All GitHub commands use: `node scripts/gh.ts` (referred to as `gh` below).

## Steps

1. **Read the issue:** Run `node scripts/gh.tsissue view $ARGUMENTS --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'` and capture the full output (title, body, labels).

1b. **Check for spec review findings:** Run `node scripts/gh.tsapi repos/{owner}/{repo}/issues/<id>/comments --paginate --jq '.[] | "--- comment \(.id) | \(.user.login) | \(.created_at) ---\n\(.body)\n"'`. Look for the most recent comment containing `## Spec Review` and `## Verdict:`. If found and the verdict is `needs-work`, **STOP**: "Issue #<id> has unresolved spec review findings. Run `/respond-to-spec-review <id>` to address them." If the verdict is `approve` or no review comment exists, continue with step 2.

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
   > **IMPORTANT: Show your work.** Every claim must include evidence — the search queries you ran, the files you read, the line numbers you found. "X doesn't exist" must include what you searched for and where. "Found 3 callers" must list them. Conclusions without receipts are unacceptable; providing proof forces thorough investigation and lets the consuming agent challenge weak searches.
   >
   > Do ALL of the following and return a structured summary:
   >
   > **Workflow history:**
   > 1. Read `.narratorr/cl/workflow-log.md` — find entries touching the same area (matching file paths, service names, feature names). Note recurring workarounds, fix iterations, infrastructure gaps.
   > 2. Read `.narratorr/cl/observations.md` — look for known debt, gotchas, or patterns relevant to the scope.
   > 3. Scan `.narratorr/cl/learnings/` — grep learning files by scope tags and file paths matching the issue's area.
   > 4. Read `.narratorr/cl/debt.md` — check for known debt items in the target area.
   >
   > **Codebase exploration:**
   > 5. Find similar existing features (e.g., if adding a new adapter, look at existing adapters)
   > 6. Check interfaces/types relevant to the issue
   > 7. Identify touch points — wiring files, registries, route registrations
   > 8. Note naming conventions, folder structure, and test patterns used by similar features
   > 9. Check existing test files in the target area (co-located `*.test.ts(x)` files). Note what's already covered, what patterns/helpers they use, and which areas have no tests yet. This saves significant implementation time by avoiding duplicate test setup.
   >
   > **Mechanical verification (CRITICAL — prevents spec review round-trips):**
   > 10. For every file path, function name, schema field, or status literal mentioned in the spec, grep the codebase to confirm it exists. Report any that don't — these are fabricated artifacts that will cause implementation failures.
   > 11. For extraction/refactoring issues: build a complete caller matrix by grepping for the function/class being extracted across ALL of `src/` (routes, services, jobs, pipelines — not just the obvious callers). Missing callers are the #1 cause of extraction spec review failures.
   > 12. Blast radius: grep for each literal value (not just type names) across `src/` AND `**/*.test.ts*`. A type rename that misses 3 test fixtures is a guaranteed review finding.
   >
   > **Deep source analysis for test plan (CRITICAL — read actual source, not just signatures):**
   > 10. For every service/util/route the issue will modify or call, READ THE FULL SOURCE and identify:
   >    - Null/zero/undefined guards and what happens when they trigger (e.g., returns null, throws, skips)
   >    - Division, ratio, or threshold calculations and their boundary behavior
   >    - Optional fields on interfaces that callers may or may not provide
   >    - Falsy coercion gotchas (e.g., `value || fallback` where `value=0` is valid but falsy)
   >    - Protocol/type-specific logic (e.g., filters that apply to torrent but not usenet)
   >    - Transient vs persisted fields (flags that trigger actions but aren't stored in DB)
   >    - Fire-and-forget patterns where failure must not break the parent operation
   >    - Race conditions: data read in one step, used in a later step where it may have changed
   > 11. For each finding, note the specific file, line range, and the test scenario it implies
   >
   > Include a new section in the return structure:
   > ```
   > DEFECT VECTORS: <list of specific edge cases found by reading source, with file:line references and implied test scenarios>
   > ```
   >
   > **Overlap and dependencies:**
   > 12. Run `node scripts/gh.tspr list --state open --limit 50 --json number,state,title,headRefName,baseRefName,url --jq '.[] | "#\(.number) [\(.state | ascii_downcase)] \(.title)\n   \(.headRefName) → \(.baseRefName) | \(.url)"'` — any open PR touching the same area?
   > 13. Check for `status/in-progress` issues that overlap in scope
   > 14. For any issues referenced as dependencies (e.g., "depends on #X"), run `node scripts/gh.tsissue view <dep-id> --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'` to verify status
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
     - Write updated body to a temp file, then: `node scripts/gh.tsissue edit <id> --body-file <temp-file-path>`
     - Clean up the temp file
   - **Fixture blast radius (trigger: spec touches settings schema, DB schema, or shared types):** If the spec adds/removes fields on settings categories, DB tables, or shared type interfaces, add a `## Fixture Blast Radius` section listing all test files that hardcode the affected shape. Grep `**/*.test.ts` and `**/*.test.tsx` for inline fixtures of the changed type. This prevents the #1 cascade problem — implementers discovering 10+ broken test files mid-implementation.
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

6. **Update labels based on verdict** (for `automate`-tagged issues):
   - If the issue has the `automate` label AND verdict is `ready` or `filled`:
     - Run: `node scripts/update-labels.ts <id> --replace "status/" "status/review-spec"`
   - If the issue has the `automate` label AND verdict is `not-ready`:
     - Post a comment explaining why: `node scripts/gh.tsissue comment <id> --body "**BLOCKED — elaboration verdict: not-ready**\n\nContext: <1-2 sentences about what's missing or unresolvable>\n\nNeeded: <what must be fixed before this can proceed>"`
     - Add blocked flag: `node scripts/block.ts <id> "Elaboration verdict: not-ready — <reason>"`
   - If the issue does NOT have `automate`: do not change labels (manual workflow — `/claim` handles labels)

## Important

- This skill is read-only except for updating the issue body (step 4) with durable content and labels (step 6) for `automate`-tagged issues
- Do NOT create branches — that's `/claim`'s job
- Do NOT suggest claiming or starting implementation — just report readiness
- Ephemeral codebase findings stay in the verdict output — they're consumed by `/claim` or the user, not persisted to the issue
