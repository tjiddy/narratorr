---
name: elaborate
description: Groom, validate, or respond to spec review findings on a Gitea issue.
  Auto-detects mode from issue comments. Use when user says "elaborate", "groom issue",
  or invokes /elaborate.
argument-hint: <issue-id>
---

# /elaborate <id> — Groom, validate, or respond to spec review findings

Standalone grooming/triage skill with two modes:

- **Groom mode** (default): Reads the issue, explores the codebase for gaps, checks dependencies, and reports a structured readiness verdict.
- **Respond mode** (automatic): When the latest comment is a `/review-spec` verdict of `needs-work`, shifts to addressing the review findings — updates the spec body to fix each finding, posts a structured response comment, then reports readiness.

Mode is detected automatically from issue comments — no flags needed.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

0. **Read the project context cache:** Read `.claude/project-context.md` to understand current codebase state (interfaces, patterns, wiring, schema). Only explore the codebase further for information NOT covered by the cache.

1. **Read the issue:** Run `gitea issue $ARGUMENTS` and capture the full output (title, body, labels, milestone).

1b. **Check for spec review findings:** Run `gitea issue-comments <id>`. Look for the most recent comment containing `## Spec Review` and `## Verdict:`. If found and the verdict is `needs-work`, switch to **Respond mode** (jump to step R1). If the verdict is `approve` or no review comment exists, continue with **Groom mode** (step 2).

2. **Parse spec completeness.** Check the issue body for:
   - **Acceptance Criteria** — clear, testable statements (REQUIRED)
   - **Test Plan** — specific test cases or commands (REQUIRED)
   - **Implementation detail** — file paths, service/route names, enough to start coding (recommended)
   - **Dependencies** — references to other issues (check their status)
   - **Scope boundaries** — what's explicitly out of scope (recommended)

3. **Read workflow history and observations:**
   - Read `.claude/workflow-log.md` if it exists — scan for entries that touch the same area as this issue (matching file paths, service names, or feature names). Note any recurring workarounds, fix iterations, or infrastructure gaps.
   - Read `.claude/observations.md` if it exists — look for known debt, gotchas, or patterns relevant to the issue's scope.
   - Scan `.claude/learnings/` if it exists — grep learning files by scope tags and file paths matching the issue's area. Read any relevant learnings.
   - Read `.claude/debt.md` if it exists — check for known debt items in the target area.
   - Carry forward any relevant findings to include in the verdict output under a **"Implementation Hazards"** heading (e.g., "workflow log shows mock update churn in this area", "learning: useMutation passes extra args to mutationFn", "debt: missing mock factories for Book type").

4. **Explore the codebase for gaps not covered by context cache:**
   - Only explore if the context cache doesn't have the needed info
   - Find similar existing features (e.g., if adding a new adapter, look at existing adapters)
   - Check interfaces/types relevant to the issue
   - Identify touch points — wiring files, registries, route registrations
   - Note naming conventions, folder structure, and test patterns used by similar features

5. **Check for overlapping work:**
   - Run `gitea prs` — any open PR touching the same area?
   - Any `status/in-progress` issues that overlap in scope?

6. **Check dependencies:**
   - If the issue references other issues (e.g., "depends on #X"), verify those are `status/done`
   - Run `gitea issue <dep-id>` for each dependency to check status

7. **Fill gaps — durable content only:**
   - Split findings into two channels:
     - **Durable** (written to issue body): Missing AC items, test plan items, scope boundaries inferred from codebase
     - **Ephemeral** (kept in verdict output only, NOT written to issue): File paths, interface signatures, wiring points, similar feature references
   - If durable content was found, update the issue body:
     - Preserve ALL existing content
     - Append new sections (e.g., `## Implementation Notes (auto-generated)`)
     - Write updated body to a temp file, then: `gitea issue-update <id> body --body-file <temp-file-path>`
     - Clean up the temp file
   - Only update the body if you're adding genuinely useful durable detail — don't pad it

8. **Report structured readiness verdict.** Use this format:

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

---

## Respond Mode (spec review findings)

Triggered automatically when the latest review comment has `Verdict: needs-work`.

**R1. Parse the review findings.** Extract the `## Findings` JSON block from the latest review comment. For each finding, note:
   - `id` (F1, F2, etc.)
   - `severity` (blocking / suggestion)
   - `category`, `description`, `reason`, `suggestion`

**R2. Explore the codebase** as needed to address the findings. Same as groom mode step 4 — only explore for info not in the context cache.

**R3. Address each finding.** For each finding, determine a disposition:
   - **`fixed`** — Update the spec body to address the finding. Describe what changed.
   - **`accepted`** — Agree with the finding but handle it differently than suggested. Explain why.
   - **`deferred`** — Valid finding but out of scope. Create a chore issue if needed: `gitea issue-create "<title>" --body-file <path> "type/chore"`.
   - **`disputed`** — Disagree with the finding. Explain why with evidence.

   All `blocking` findings MUST be `fixed` or `disputed`. `suggestion` findings can be any disposition.

   **Root cause capture:** For every finding resolved as `fixed`, write a learning file to `.claude/learnings/` capturing what gap let this slip through. Create the directory if it doesn't exist.
   - Filename: `.claude/learnings/spec-review-<finding-id-lowercase>.md` (e.g., `spec-review-f1.md`)
   - Format:
     ```yaml
     ---
     scope: [<matching issue scope labels>]
     files: []
     issue: <issue-id>
     source: spec-review
     date: <YYYY-MM-DD>
     ---
     <What the reviewer caught, why the spec missed it, and what would have prevented it (vague AC? missing test plan? scope/claim mismatch? didn't check codebase?).>
     ```
   This feeds the same learning pipeline as PR review learnings — `/triage` can graduate recurring spec gaps into process fixes.

**R4. Update the issue body.** Apply all `fixed` changes to the spec:
   - Preserve ALL existing content structure
   - Modify in-place where the finding points to a specific section (e.g., fix an AC item, add a Test Plan section)
   - Write updated body to a temp file, then: `gitea issue-update <id> body --body-file <temp-file-path>`
   - Clean up the temp file

**R5. Post a response comment.** Write a structured response and post it:
   ```
   ## Spec Review Response

   <1-2 sentence summary of changes made>

   | Finding | Severity | Disposition | Detail |
   |---------|----------|-------------|--------|
   | F1 | blocking | fixed | <what changed> |
   | F2 | suggestion | accepted | <why> |
   ```
   Write to temp file, then: `gitea issue-comment <id> --body-file <temp-file-path>`

**R6. Report readiness verdict** — same format as groom mode step 8. The verdict reflects the spec's state *after* your fixes.

## Important

- **Groom mode** is read-only except for updating the issue body (step 7) with durable content
- **Respond mode** writes to the issue body (step R4) and posts a response comment (step R5)
- Do NOT change labels or create branches in either mode — that's `/claim`'s job (groom) or `/review-spec`'s job (respond)
- Do NOT suggest claiming or starting implementation — just report readiness
- Ephemeral codebase findings stay in the verdict output — they're consumed by `/claim` or the user, not persisted to the issue
