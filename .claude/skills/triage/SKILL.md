---
name: triage
description: Rank and categorize all open issues by priority. Read-only analysis
  with no side effects. Use when user says "triage issues", "prioritize backlog",
  or invokes /triage.
---

!`cat .claude/docs/workflow.md`

# /triage — Rank and categorize open issues

Read-only skill that surveys all open issues and produces a prioritized ranking. Runs as a general-purpose subagent to keep verbose output out of main context.

## GitHub CLI

All GitHub commands use: `node scripts/gh.ts` (referred to as `gh` below).

## Steps

1. **Fetch all open issues:** Run `node scripts/gh.tsissue list --state open --limit 100 --json number,state,title,labels,milestone --jq '.[] | "#\(.number) [\(.state | ascii_downcase)] \(.title)\n   labels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)"'` to get all open issues.

2. **Read each issue:** For each issue, run `node scripts/gh.tsissue view <id> --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'` to get the full body. Parse from body text only (NO codebase exploration):
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

   a. **Read learnings:** Scan all files in `.claude/cl/learnings/`. Group by theme (same scope, same files, same type of problem).

   b. **Read debt:** Read `.claude/cl/debt.md` if it exists.

   c. **Read "Wish I'd Known" entries:** Scan `.claude/cl/workflow-log.md` for `### Wish I'd Known` sections. Note any items that recur across multiple issues.

   c2. **Read review retrospectives:** Scan all files in `.claude/cl/reviews/`. These contain specific "Prompt fix" suggestions from implementers (respond-to-*) and reviewers (review-*) identifying what prompt changes would have caught issues earlier. Group by target skill — multiple retrospectives suggesting changes to the same skill prompt are high-signal candidates for graduation.

   d. **Classify each cluster/item** into one of:
      - **Code fix** — a concrete change to the repo would eliminate this class of problem (e.g., "mock factories would prevent stale mock breakage"). → Suggest creating a GitHub issue. Include the proposed scope and rationale.
      - **Workflow change** — a change to a skill prompt would catch or prevent this (e.g., "review-spec should check for catch-all blocks"). Review retrospectives (`.claude/cl/reviews/`) are the primary source here — they contain pre-written "Prompt fix" suggestions. When multiple retrospectives across different issues suggest the same prompt change, that's a strong signal to graduate. → Suggest which skill to change and what to add, quoting the retrospective's proposed text where available.
      - **CLAUDE.md rule** — a convention or pattern that should be documented for all contributors (e.g., "always use FastifyBaseLogger, not BaseLogger from pino"). → Suggest the specific addition.
      - **Inherent** — no action possible; this is a runtime/tooling reality that can't be fixed, only known (e.g., "jsdom doesn't support responsive breakpoints"). → No action. Learning stays in `.claude/cl/learnings/` for `/claim` to surface.

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

   g. **Prune learnings (mandatory).** For each file in `.claude/cl/learnings/`, sort into one of three buckets:
      - **Graduate** — the insight is valuable and recurring. Capture it in a durable location (skill prompt change, CLAUDE.md rule, debt issue, or memory), then delete the file.
      - **Keep** — genuinely useful gotcha not yet captured elsewhere. Leave it.
      - **Delete (dogshit)** — nuke the file. Criteria for deletion:
        - *Too specific* — fix for one test/file in one PR, not a reusable pattern
        - *Already obvious* — restates something already in testing standards, CLAUDE.md, or skill prompts
        - *Stale* — references code/patterns that have been refactored away
        - *Duplicate* — same insight exists in another learning or has already been graduated

      Present the three-way sort to the user for approval before deleting. Also remove resolved debt items from `.claude/cl/debt.md`.

   h. **Truncate workflow-log.md** — replace contents with just `# Workflow Log\n`. All useful items have been graduated to their destinations (debt.md, GitHub issues, skill prompt changes). Non-graduated entries are discarded. This keeps the file bounded since it's tracked in git.

## Important

- This skill is **read-only** — no label changes, no comments, no branches
- Do NOT explore the codebase — spec analysis only (from issue body text) for issue triage
- Do NOT run `/elaborate` on each issue — that's too expensive. Just parse the body
- Subagent keeps verbose per-issue reads out of main context
- CL graduation (step 3) runs in main context since it needs user interaction for approvals
