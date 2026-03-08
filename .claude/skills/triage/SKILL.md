---
name: triage
description: Rank and categorize all open issues by priority. Read-only analysis
  with no side effects. Use when user says "triage issues", "prioritize backlog",
  or invokes /triage.
---

# /triage — Rank and categorize open issues

Read-only skill that surveys all open issues and produces a prioritized ranking. Runs as a general-purpose subagent to keep verbose output out of main context.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Fetch all open issues:** Run `gitea issues` to get all open issues.

2. **Read each issue:** For each issue, run `gitea issue <id>` to get the full body. Parse from body text only (NO codebase exploration):
   - Acceptance Criteria: present / missing
   - Test Plan: present / missing
   - Dependencies: list any `#<id>` references, note if those are open/closed
   - Labels: extract status, priority, type, scope

3. **Categorize each issue** into one of:
   - **Ready to Claim** — has `status/ready` label, AC and test plan present, no unmet deps
   - **Needs Grooming** — missing AC, test plan, or implementation detail
   - **Blocked on Deps** — references open issues that aren't `status/done`
   - **Overlapping** — scope overlaps with any `status/in-progress` issue

4. **Sort** within each group by priority label (high → medium → low → unlabeled).

5. **Report structured results:**
   ```
   ## Ready to Claim
   - #<id> <title> [priority/<x>] — <1-line summary>

   ## Needs Grooming
   - #<id> <title> — missing: <AC|test plan|detail>

   ## Blocked on Deps
   - #<id> <title> — waiting on: #<dep-id> (<dep status>)

   ## Overlapping
   - #<id> <title> — overlaps with: #<other-id> (in-progress)

   ## Recommendation
   Next issue to pick up: #<id> — <why>
   ```

3. **Continuous Learning graduation** — after the issue triage, process accumulated learnings and debt:

   a. **Read learnings:** Scan all files in `.claude/learnings/`. Group by theme (same scope, same files, same type of problem).

   b. **Read debt:** Read `.claude/debt.md` if it exists.

   c. **Read "Wish I'd Known" entries:** Scan `.claude/workflow-log.md` for `### Wish I'd Known` sections. Note any items that recur across multiple issues.

   d. **Classify each cluster/item** into one of:
      - **Code fix** — a concrete change to the repo would eliminate this class of problem (e.g., "mock factories would prevent stale mock breakage"). → Suggest creating a Gitea issue. Include the proposed scope and rationale.
      - **Workflow change** — a change to a plugin skill would catch or prevent this (e.g., "review-spec should check for catch-all blocks"). → Suggest which skill to change and what to add.
      - **CLAUDE.md rule** — a convention or pattern that should be documented for all contributors (e.g., "always use FastifyBaseLogger, not BaseLogger from pino"). → Suggest the specific addition.
      - **Inherent** — no action possible; this is a runtime/tooling reality that can't be fixed, only known (e.g., "jsdom doesn't support responsive breakpoints"). → No action. Learning stays in `.claude/learnings/` for `/claim` to surface.

   e. **Report graduation recommendations** in a structured section:
      ```
      ## CL Graduation Recommendations

      ### Code Fixes (create issues)
      - <description> — based on: <learning files / debt items / wish-I'd-known entries>

      ### Workflow Changes (skill edits)
      - <skill>: <what to change> — based on: <learning files>

      ### CLAUDE.md Additions
      - <rule to add> — based on: <learning files>

      ### Inherent (no action)
      - <description> — stays in learnings for /claim to surface
      ```

   f. **Do NOT auto-create issues or edit skills** — just recommend. The user decides what to act on. This step is advisory.

   g. After the user approves actions, graduated learnings can be removed from `.claude/learnings/` and resolved debt items removed from `.claude/debt.md`.

## Important

- This skill is **read-only** — no label changes, no comments, no branches
- Do NOT explore the codebase — spec analysis only (from issue body text) for issue triage
- Do NOT run `/elaborate` on each issue — that's too expensive. Just parse the body
- Subagent keeps verbose per-issue reads out of main context
- CL graduation (step 3) runs in main context since it needs user interaction for approvals
