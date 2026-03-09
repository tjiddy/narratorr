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
        - type: prompt
          prompt: "The agent is running /respond-to-pr-review (fix findings → verify → push → post response comment → update labels). Check its last message. It is DONE only if it contains 'ready-for-re-review' or 'needs-human-input' status report, or an explicit STOP/block condition. If the last message is a verify summary (OVERALL: pass/fail) or test output without a subsequent push, comment post, or label update, respond {\"ok\": false, \"reason\": \"Review response incomplete. Verify passed but you still need to: git push, post the Review Response comment on the PR, and update issue labels. Continue immediately.\"}. If complete or blocked, respond {\"ok\": true}."
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/workflow.md`

!`cat .claude/docs/design-principles.md`

# /respond-to-pr-review <pr-number> — Address review findings on a PR

Author agent reads the review, addresses each finding with an explicit resolution, pushes fixes, and posts a structured response.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

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

   Rules:
   - Every finding MUST have an explicit resolution — nothing gets silently skipped
   - `blocking` findings can only be `fixed` or `disputed`
   - `suggestion` findings can be `fixed`, `accepted`, or `deferred`

4. **Determine flow:**

   **Clean flow** (no disputed blocking findings):
   - Run quality gates: `node scripts/verify.ts`
     - If output starts with `VERIFY: fail` → fix issues and re-run until clean
     - If output starts with `VERIFY: pass` → continue to push RIGHT NOW. You still need to push, post the response comment, and update labels.
   - Push: `git push origin <head-branch>`
   - Post response comment (see template below)
   - **Update labels:** If the linked issue has the `yolo` label, run: `node scripts/update-labels.ts <id> --replace "stage/" "stage/review-pr"`

   **Dispute flow** (any blocking finding is disputed):
   - Push any fixes made so far: `git push origin <head-branch>`
   - Post response comment with rebuttal reasoning
   - Find linked issue number from PR body (`Refs #<id>`)
   - Update issue labels: `node scripts/update-labels.ts <id> --replace "status/" "status/blocked"`
   - Post blocked comment on issue: `gitea issue-comment <id> "Blocked: PR #<pr-number> has disputed blocking findings requiring human input. See PR comments."`
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

6. **Report to main agent:** "**PR #<pr-number> (issue #<id>)** — <status: ready-for-re-review | needs-human-input> — <1-line summary of resolutions>"

## Important

- **Do NOT pause between steps.** This skill runs end-to-end without user interaction. When `/verify` returns, immediately continue to push and post the response comment. The Skill tool returning is a mid-flow return value, not a stopping point.
- This skill is for the **author agent** — the one who wrote the code, not the reviewer
- Every finding requires an explicit resolution. The response table must have one row per finding — or one row per sub-item if the reviewer enumerated them (e.g., F2a, F2b, F2c).
- Disputed blocking findings → `needs-human-input` status → issue goes `status/blocked` → STOP
- Clean resolutions (all blocking fixed, suggestions resolved) → `ready-for-re-review`
- Do NOT merge — that's the reviewer's job via `/merge`
- When creating deferred issues, use descriptive titles and reference the PR number in the body
