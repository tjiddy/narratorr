---
name: respond-to-spec-review
description: Address spec review findings on a Gitea issue — update the spec body,
  post a structured response. Use when user says "respond to spec review", "address
  spec findings", or invokes /respond-to-spec-review.
argument-hint: <issue-id>
disable-model-invocation: true
---

!`cat .claude/docs/workflow.md`

# /respond-to-spec-review <id> — Address spec review findings on a Gitea issue

Reads the latest `/review-spec` verdict on an issue, addresses each finding by updating the spec body, posts a structured response comment, and reports readiness.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Read the issue:** Run `gitea issue $ARGUMENTS` and capture the full output (title, body, labels, milestone).

2. **Verify spec review findings exist:** Run `gitea issue-comments <id>`. Look for the most recent comment containing `## Spec Review` and `## Verdict:`.
   - If found and the verdict is `needs-work` → proceed to step 3.
   - If the verdict is `approve` → **STOP**: "Issue #<id> spec review verdict is already `approve`. Nothing to respond to."
   - If no review comment exists → **STOP**: "No spec review found on issue #<id>. Run `/review-spec <id>` first."

3. **Parse the review findings.** Extract the `## Findings` JSON block from the latest review comment. For each finding, note:
   - `id` (F1, F2, etc.)
   - `severity` (blocking / suggestion)
   - `category`, `description`, `reason`, `suggestion`

4. **Explore the codebase** as needed to address the findings.

5. **Address each finding.** For each finding, determine a disposition:
   - **`fixed`** — Update the spec body to address the finding. Describe what changed.
   - **`accepted`** — Agree with the finding but handle it differently than suggested. Explain why.
   - **`deferred`** — Valid finding but out of scope. Create a chore issue if needed: `gitea issue-create "<title>" --body-file <path> "type/chore"`.
   - **`disputed`** — Disagree with the finding. Explain why with evidence.

   All `blocking` findings MUST be `fixed` or `disputed`. `suggestion` findings can be any disposition.

   **Root cause capture:** For every finding resolved as `fixed`, write a learning file to `.claude/cl/learnings/` capturing what gap let this slip through. Create the directory if it doesn't exist.
   - Filename: `.claude/cl/learnings/spec-review-<issue-id>-<finding-id-lowercase>.md` (e.g., `spec-review-158-f1.md`)
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

6. **Verify fixes before writing.** Before updating the issue body, verify every factual claim your fixes introduce — file paths exist (`ls`), gitignore status is correct (`git check-ignore`), named artifacts are present. Each review round is expensive; don't introduce new defects while fixing old ones.

7. **Update the issue body.** Apply all `fixed` changes to the spec:
   - Preserve ALL existing content structure
   - Modify in-place where the finding points to a specific section (e.g., fix an AC item, add a Test Plan section)
   - Write updated body to a temp file, then: `gitea issue-update <id> body --body-file <temp-file-path>`
   - Clean up the temp file

8. **Post a response comment.** Write a structured response and post it:
   ```
   ## Spec Review Response

   <1-2 sentence summary of changes made>

   | Finding | Severity | Disposition | Detail |
   |---------|----------|-------------|--------|
   | F1 | blocking | fixed | <what changed> |
   | F2 | suggestion | accepted | <why> |
   ```
   Write to temp file, then: `gitea issue-comment <id> --body-file <temp-file-path>`

9. **Update labels** (for `yolo`-tagged issues):
   - If the issue has the `yolo` label:
     - Run: `node scripts/update-labels.ts <id> --replace "status/" "status/review-spec"`
   - If the issue does NOT have `yolo`: do not change labels (manual workflow)

10. **Report readiness verdict** using this format:

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

   Preceded by: "**#<id> spec response complete**" and followed by a brief prose explanation (2-3 sentences max) of the verdict.

## Important

- This skill writes to the issue body (step 7), posts a response comment (step 8), and updates labels (step 9) for yolo-tagged issues
- Do NOT create branches — that's `/claim`'s job
- Do NOT suggest claiming or starting implementation — just report readiness
- Ephemeral codebase findings stay in the verdict output — they're consumed by `/claim` or the user, not persisted to the issue
