---
name: respond-to-spec-review
description: Address spec review findings on a GitHub issue — update the spec body,
  post a structured response. Use when user says "respond to spec review", "address
  spec findings", or invokes /respond-to-spec-review.
argument-hint: <issue-id>
disable-model-invocation: true
---

!`cat .claude/docs/workflow.md`

# /respond-to-spec-review <id> — Address spec review findings on a GitHub issue

Reads the latest `/review-spec` verdict on an issue, addresses each finding by updating the spec body, posts a structured response comment, and reports readiness.

## GitHub CLI

All GitHub commands use: `gh` (referred to as `gh` below).

## Steps

1. **Read the issue:** Run `gh issue view $ARGUMENTS --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'` and capture the full output (title, body, labels).

2. **Verify spec review findings exist:** Run `gh api repos/{owner}/{repo}/issues/<id>/comments --paginate --jq '.[] | "--- comment \(.id) | \(.user.login) | \(.created_at) ---\n\(.body)\n"'`. Look for the most recent comment containing `## Spec Review` and `## Verdict:`.
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
   - **`deferred`** — Valid finding but out of scope. Create a chore issue if needed: `gh issue create --title "<title>" --body-file <path> --label "type/chore"`.
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
   - Write updated body to a temp file, then: `gh issue edit <id> --body-file <temp-file-path>`
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
   Write to temp file, then: `gh issue comment <id> --body-file <temp-file-path>`

9. **Update labels** (for `automate`-tagged issues):
   - If the issue has the `automate` label:
     - Run: `node scripts/update-labels.ts <id> --replace "status/" "status/review-spec"`
   - If the issue does NOT have `automate`: do not change labels (manual workflow)

10. **Prompt improvement retrospective (for `fixed` findings only):**
    For each finding resolved as `fixed`, analyze: "Why did I miss this when writing the spec? What specific addition or change to a skill prompt (`/spec`, `/elaborate`, or CLAUDE.md) would have helped me catch this before it went out for review?"

    Write a single retrospective file: `.claude/cl/reviews/spec-<issue-id>-round-<N>.md` (where N is the review round number, inferred from the number of prior `## Spec Review` comments + 1). Create `.claude/cl/reviews/` if it doesn't exist.

    Format:
    ```yaml
    ---
    skill: respond-to-spec-review
    issue: <id>
    round: <N>
    date: <YYYY-MM-DD>
    fixed_findings: [F1, F3, ...]
    ---
    ```
    Then for each fixed finding:
    ```
    ### <finding-id>: <short description>
    **What was caught:** <the finding>
    **Why I missed it:** <root cause — vague AC? didn't check codebase? missing test plan? scope assumption?>
    **Prompt fix:** <specific text to add/change in a specific skill prompt or CLAUDE.md>
    ```

    Be specific in "Prompt fix" — "check more carefully" is useless. "Add to /spec AC checklist: 'For DB schema changes, verify all existing callers of affected queries'" is actionable.

11. **Commit and push CL files:** Learning and retrospective files from step 10 need to be committed to main so all clones stay in sync:
    ```bash
    git add .claude/cl/
    git commit -m "CL from #<id> spec review response"
    git push origin main
    ```
    If there's nothing to commit (no new CL files), skip this step.

12. **Report readiness verdict** using this format:

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

- This skill writes to the issue body (step 7), posts a response comment (step 8), and updates labels (step 9) for `automate`-tagged issues
- Do NOT create branches — that's `/claim`'s job
- Do NOT suggest claiming or starting implementation — just report readiness
- Ephemeral codebase findings stay in the verdict output — they're consumed by `/claim` or the user, not persisted to the issue
