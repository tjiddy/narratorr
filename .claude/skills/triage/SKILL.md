# /triage — Rank and categorize open issues

Read-only skill that surveys all open issues and produces a prioritized ranking. Runs as a general-purpose subagent to keep verbose output out of main context.

## Steps

1. **Launch a general-purpose subagent** (via Task tool, subagent_type=general-purpose) with these instructions:

   a. Run `pnpm gitea issues` to get all open issues.

   b. For each issue, run `pnpm gitea issue <id>` to get the full body. Parse from body text only (NO codebase exploration):
      - Acceptance Criteria: present / missing
      - Test Plan: present / missing
      - Dependencies: list any `#<id>` references, note if those are open/closed
      - Labels: extract status, priority, type, scope

   c. Categorize each issue into one of:
      - **Ready to Claim** — has `status/ready` label, AC and test plan present, no unmet deps
      - **Needs Grooming** — missing AC, test plan, or implementation detail
      - **Blocked on Deps** — references open issues that aren't `status/done`
      - **Overlapping** — scope overlaps with any `status/in-progress` issue

   d. Sort within each group by priority label (high → medium → low → unlabeled).

   e. Return structured report:
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

2. **Report the subagent's output** to the user.

## Important

- This skill is **read-only** — no label changes, no comments, no branches
- Do NOT explore the codebase — spec analysis only (from issue body text)
- Do NOT run `/elaborate` on each issue — that's too expensive. Just parse the body
- Subagent keeps verbose per-issue reads out of main context
