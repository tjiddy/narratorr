---
name: respond-to-pr-review
description: Address review findings on a PR — fix, accept, defer, or dispute each
  finding, push fixes, and post a structured response. Use when user says "respond
  to PR review", "address PR findings", or invokes /respond-to-pr-review.
argument-hint: <pr-number>
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node scripts/hooks/stop-gate.ts respond-to-pr-review"
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/workflow.md`

!`cat .claude/docs/design-principles.md`

# /respond-to-pr-review <pr-number> — Address review findings on a PR

Author agent reads the review, addresses each finding with an explicit resolution, pushes fixes, and posts a structured response.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

0. **Initialize stop-gate state:** `mkdir -p .claude/state/respond-to-pr-review-<pr-number>/`

1. **Fetch PR and checkout branch:**
   - Run `gitea pr <pr-number>` to get head branch and linked issue (`Refs #<id>`)
   - `git fetch origin <head-branch> && git checkout <head-branch>`

2. **Read review comments:**
   - Run `gitea pr-comments <pr-number>`
   - Find the most recent comment containing `## Verdict:` — this is the active review
   - Parse the `## Findings` JSON block from that comment
   - If no findings JSON found, report error and stop

3. **Address each finding** — For every finding in the JSON array, choose exactly one resolution:

   - **`fixed`** — Make the code change that addresses the finding, then `git add` and `git commit` with message referencing the finding ID (e.g., `fix: address F1 — add missing test for edge case`)
   - **`accepted`** — Current code is correct as-is. Provide concrete reasoning why (not just "I disagree"). Valid for `suggestion` severity only — you cannot accept a `blocking` finding without fixing or disputing it.
   - **`deferred`** — Create a chore issue in Gitea: `gitea issue-create "<title>" --body-file <path> "type/chore"`. Reference the new issue number in the response. Valid for `suggestion` severity only.
   - **`disputed`** — The finding is genuinely wrong. Provide a rebuttal with evidence (code references, docs, test results). Valid for `blocking` findings only — if you believe a blocking finding is incorrect, dispute it rather than silently accepting.

   **Root cause capture:** For every finding resolved as `fixed`, write a learning file to `.claude/cl/learnings/` capturing what gap let this slip through. Create the directory if it doesn't exist.
   - Filename: `.claude/cl/learnings/review-<issue-id>-<finding-id-lowercase>.md` (e.g., `review-158-f1.md`)
   - Format:
     ```yaml
     ---
     scope: [<matching issue scope labels>]
     files: [<files involved>]
     issue: <linked-issue-id>
     source: review
     date: <YYYY-MM-DD>
     ---
     <What the reviewer caught, why we missed it, and what would have prevented it (spec gap? explore gap? test gap? pattern we didn't know about?).>
     ```
   This feeds the same learning pipeline as implementation learnings — `/triage` can graduate recurring review-sourced gaps into process fixes.

   **Sibling pattern check (blast radius):** Before committing any fix, ask: "Does this same gap exist in sibling files?" Grep for all instances of the pattern being fixed across the codebase. If the same issue exists in other files (e.g., same missing field in other test fixtures, same validation gap in other adapters, same error handling pattern in other services), fix all instances — not just the one the reviewer called out. Enumerate the full list of affected files; do not use "e.g." or partial examples.

   Rules:
   - Every finding MUST have an explicit resolution — nothing gets silently skipped
   - `blocking` findings can only be `fixed` or `disputed`
   - `suggestion` findings can be `fixed`, `accepted`, or `deferred`

3b. **Write phase marker:** `echo done > .claude/state/respond-to-pr-review-<pr-number>/findings-addressed`

4. **Determine flow:**

   **Clean flow** (no disputed blocking findings):
   - **Fix completeness gate:** For each finding resolved as `fixed`, verify the fix is complete using this hierarchy:
     - (a) If the finding cites a specific command or test, rerun it and confirm it passes.
     - (b) If the finding describes a code pattern (e.g., missing assertion, wrong argument), run a targeted grep to confirm the pattern is resolved everywhere — not just in the file the reviewer flagged.
     - (c) If no repeatable check exists (e.g., prose observation about naming or clarity), note in the response comment what manual verification was performed.
   - Run quality gates: `node scripts/verify.ts`
     - If output starts with `VERIFY: fail` → fix issues and re-run until clean
     - If output starts with `VERIFY: pass` → write phase marker: `echo done > .claude/state/respond-to-pr-review-<pr-number>/verify-complete` and continue to push RIGHT NOW. You still need to push, post the response comment, and update labels.
   - Push: `git push origin <head-branch>`
   - Post response comment (see template below)
   - **Update labels:** Set `stage/review-pr` on the **PR**: `node scripts/update-labels.ts <pr-number> --pr --replace "stage/" "stage/review-pr"`
   - Set `status/in-review` on the **issue**: `node scripts/update-labels.ts <id> --replace "status/" "status/in-review"`

   **Dispute flow** (any blocking finding is disputed):
   - Push any fixes made so far: `git push origin <head-branch>`
   - Post response comment with rebuttal reasoning
   - Find linked issue number from PR body (`Refs #<id>`, `closes #<id>`, or `fixes #<id>`)
   - Add `blocked` flag to issue: `node scripts/block.ts <id> "PR #<pr-number> has disputed blocking findings requiring human input. See PR comments."`
   - Write stopped marker: `echo done > .claude/state/respond-to-pr-review-<pr-number>/stopped`
   - **STOP** — do not continue. Human must weigh in.

5. **Post response comment on PR:**
   - Write comment to temp file, then: `gitea pr-comment <pr-number> --body-file <temp-file-path>`
   - Template:
     ```
     ## Review Response

     | Finding | Severity | Resolution | Details |
     |---------|----------|------------|---------|
     | F1 | blocking | fixed | <commit ref or explanation> |
     | F2 | suggestion | accepted | <reasoning why current code is correct> |
     | F3 | suggestion | deferred | Created #<new-issue-number> |
     | F4 | blocking | disputed | <rebuttal with evidence> |

     ## Status: ready-for-re-review | needs-human-input

     <Summary of changes made>
     ```
   - **Granularity mirroring:** If the reviewer split a finding into sub-items (e.g., F2a, F2b, F2c), the response table must have one row per sub-item — not a single collapsed "F2: fixed" row. Fixes should line up 1:1 with findings so the re-review is verification, not reinterpretation.
   - Clean up temp file

6. **Prompt improvement retrospective (for `fixed` findings only):**
   For each finding resolved as `fixed`, analyze: "Why did I miss this during implementation? What specific addition or change to a skill prompt (`/plan`, `/implement`, or CLAUDE.md) would have helped me catch this before it went out for review?"

   Write a single retrospective file: `.claude/cl/reviews/pr-<issue-id>-round-<N>.md` (where N is the review round number, inferred from the number of prior `## Verdict:` comments + 1). Create `.claude/cl/reviews/` if it doesn't exist.

   Format:
   ```yaml
   ---
   skill: respond-to-pr-review
   issue: <id>
   pr: <pr-number>
   round: <N>
   date: <YYYY-MM-DD>
   fixed_findings: [F1, F3, ...]
   ---
   ```
   Then for each fixed finding:
   ```
   ### <finding-id>: <short description>
   **What was caught:** <the finding>
   **Why I missed it:** <root cause — was it a spec gap? explore gap? test gap? pattern I didn't know about? prompt didn't mention it?>
   **Prompt fix:** <specific text to add/change in a specific skill prompt or CLAUDE.md that would catch this next time>
   ```

   Be specific in "Prompt fix" — "be more careful" is useless. "Add to /plan step 3: 'When modifying query filters, verify cache invalidation logic still matches'" is actionable.

7. **Write final phase marker and clean up:** `echo done > .claude/state/respond-to-pr-review-<pr-number>/response-posted`
   - Then clean up state: `rm -rf .claude/state/respond-to-pr-review-<pr-number>/`

8. **Report to main agent:** "**PR #<pr-number> (issue #<id>)** — <status: ready-for-re-review | needs-human-input> — <1-line summary of resolutions>"

## Important
- This skill is for the **author agent** — the one who wrote the code, not the reviewer
- Every finding requires an explicit resolution. The response table must have one row per finding — or one row per sub-item if the reviewer enumerated them (e.g., F2a, F2b, F2c).
- Disputed blocking findings → `needs-human-input` status → issue gets `blocked` flag → STOP
- Clean resolutions (all blocking fixed, suggestions resolved) → `ready-for-re-review`
- Do NOT merge — that's the reviewer's job via `/merge`
- When creating deferred issues, use descriptive titles and reference the PR number in the body
- **Test the right abstraction layer.** When a reviewer says "service-level test," they mean call the actual service method and assert its observable behavior (DB queries, return values, side effects) — not test the helpers it delegates to in isolation. If inline logic is hard to test through the service, extract it into a named testable unit first, then wire and test the delegation. Testing one layer too shallow is the #1 author-side cause of review ping-pong.
- **Assert values, not invocations.** When a finding says "test X calls Y with Z," the fix must assert the actual arguments/values, not just that the call happened. `expect(where).toHaveBeenCalled()` is not the same as `expect(where).toHaveBeenCalledWith(specificPredicate)`. If the reviewer enumerated specific constraints (column names, status values, ordering), the test must assert those exact constraints. Read the finding literally — every named constraint maps to an assertion.
