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

1. **Fetch all open issues:** Run `node scripts/gh.ts issue list --state open --limit 100 --json number,state,title,labels,milestone --jq '.[] | "#\(.number) [\(.state | ascii_downcase)] \(.title)\n   labels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)"'` to get all open issues.

2. **Read each issue:** For each issue, run `node scripts/gh.ts issue view <id> --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'` to get the full body. Parse from body text only (NO codebase exploration):
   - Acceptance Criteria: present / missing
   - Test Plan: present / missing
   - Dependencies: list any `#<id>` references, note if those are open/closed
   - Labels: extract status, priority, type, scope

3. **Categorize each issue** into one of:
   - **Ready to Claim** — has `status/ready-for-dev` label, AC and test plan present, no unmet deps
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

6. **Continuous Learning graduation** — after the issue triage, process accumulated learnings, debt, and retrospectives. This is the most important step. Every classification must be backed by research — no gut calls.

   ### Data sources

   a. **Learnings:** Read all files in `.narratorr/cl/learnings/`.
   b. **Debt:** Read `.narratorr/cl/debt.md` if it exists.
   <!-- DISABLED (workflow log retired, re-enable for next project spin-up):
   c. **Workflow log:** Read `.narratorr/cl/workflow-log.md`. Extract `### Wish I'd Known` entries.
   -->
   c. (workflow log source retired)
   <!-- DISABLED: Review retrospectives capture is turned off — see review-pr and respond-to-pr-review skills.
   d. **Review retrospectives:** Read all files in `.narratorr/cl/reviews/`. These contain "Prompt fix" suggestions from implementers and reviewers.
   -->

   ### Classification — three categories

   Every learning, debt item, and wish-I'd-known entry must be classified into exactly one of:

   **Category 1: Framework / third-party gotcha (keep)**
   A real constraint imposed by a tool, library, or runtime that we can't fix — only know. Worth keeping if the gotcha applies broadly (multiple files, multiple use cases). Delete if it's so narrow it'll never come up again.
   > Example keep: "jsdom doesn't support `backdrop-filter` stacking contexts"
   > Example delete: "vitest v4.0.17 had a bug with X" (already upgraded past it)

   **Category 2: Dogshit (delete)**
   Nuke it. Criteria:
   - *Vague self-improvement:* "I should have been more thorough" — not actionable
   - *Issue-specific:* Fix for one test/file in one closed PR, no broader pattern
   - *Already fixed:* References code that's been refactored, deleted, or patched since
   - *Already captured:* Same insight exists in CLAUDE.md, a skill prompt, testing.md, or another learning
   - *Stale reference:* Mentions issues, branches, or patterns that no longer exist

   **Category 3: Actionable (graduate)**
   Something concrete can be done. Two sub-types:

   **3a. Code issue** — a bug, missing validation, architectural problem, or debt item that needs a code change. Target the root cause, not a band-aid. If the learning describes a symptom, investigate what caused the agent to hit the problem in the first place — that's the real issue.
   > Output: issue title, scope, rationale, affected files

   **3b. Workflow / prompt update** — a change to a skill prompt, CLAUDE.md, or testing.md that would prevent the class of mistake. Must be surgical — bloating prompts dilutes their effectiveness. Only graduate if the pattern recurred across 2+ issues or the single instance was severe enough to warrant it. When multiple retrospectives suggest the same prompt change, that's strong signal.
   > Output: target file, exact text to add/change, rationale

   ### Research requirements — mandatory per item

   **You must investigate before classifying.** For each learning/item:

   1. **Read the learning file** in full — understand what happened and why.
   2. **Check the referenced issue/PR** — is it closed? Was the underlying problem fixed?
   3. **Grep/glob the codebase** — do the files/functions/patterns mentioned still exist? Has the code been refactored since?
   4. **Check for duplicates** — grep CLAUDE.md, skill prompts, and testing.md for the same concept. Is this already captured?
   5. **For actionable items:** verify the problem still exists in the current code before recommending a fix.

   **Show your work.** For every item, report:
   ```
   ### <filename>
   **Verdict:** Framework | Dogshit | Actionable (code/workflow)
   **Rationale:** <1-2 sentences — why this classification>
   **Investigation:**
   - <what you checked and what you found>
   - <e.g., "grepped for extractYear — still duplicated in paths.ts:42 and import-helpers.ts:87">
   - <e.g., "issue #210 is closed, PR #211 merged, code refactored — learning is stale">
   **Action:** <for actionable only — specific next step>
   ```

   Omitting the investigation section is a hard failure. If you can't investigate an item (e.g., references external systems you can't access), say so explicitly and classify as "keep — unable to verify."

   ### Batch processing

   Process learnings in batches using Explore subagents (up to 3 in parallel) to keep the main context clean. Each subagent receives a batch of learning files and the research requirements above, returns the structured verdicts.

   ### Report to user

   Present results grouped by verdict:

   ```
   ## CL Graduation Results

   ### Actionable — Code Issues (<count>)
   | File | Issue | Affected files | Action |
   |------|-------|---------------|--------|
   | <learning.md> | <description> | <files> | Create issue: <title> |

   ### Actionable — Workflow Updates (<count>)
   | File | Target | Change | Signal |
   |------|--------|--------|--------|
   | <learning.md> | <skill/doc> | <what to add> | <N retrospectives / N issues> |

   ### Framework Gotchas — Keep (<count>)
   | File | Gotcha | Why keep |
   |------|--------|----------|

   ### Dogshit — Delete (<count>)
   | File | Reason |
   |------|--------|

   **Summary:** <total> items processed. <N> actionable, <N> keep, <N> delete.
   ```

   ### Execution

   After user reviews and approves:
   - **Delete** all dogshit files and graduated files from `.narratorr/cl/learnings/`.
   - **Remove** resolved debt items from `.narratorr/cl/debt.md`.
   <!-- DISABLED (workflow log retired): - **Truncate** `.narratorr/cl/workflow-log.md` to `# Workflow Log\n`. -->
   - **Do NOT auto-create issues or edit skills** — the report is the deliverable. User acts on actionable items manually or queues them.

## Important

- Issue triage (steps 1-5) is **read-only** — no label changes, no comments, no branches
- Do NOT explore the codebase for issue triage — spec analysis only (from issue body text)
- Do NOT run `/elaborate` on each issue — that's too expensive. Just parse the body
- CL graduation (step 6) **requires codebase exploration** — grep, glob, read files, check git history. This is the opposite of issue triage. Do the research.
- CL graduation runs in main context for user approval, but offload investigation to Explore subagents
