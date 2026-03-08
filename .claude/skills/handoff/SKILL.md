---
name: handoff
description: Push changes, create a PR, and hand off a Gitea issue. Runs quality
  gates, posts handoff comment, updates labels, and captures learnings. Use when user
  says "hand off", "create PR", "submit for review", or invokes /handoff.
argument-hint: <issue-id>
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: "The agent is running /handoff (verify → push → create PR → update labels → post comment → workflow log). Check its last message. It is DONE only if it mentions a created PR link or an explicit STOP/failure. If the last message is a verify summary (OVERALL: pass/fail), a coverage review, or any mid-workflow output without a PR link, respond {\"ok\": false, \"reason\": \"Handoff incomplete. Verify passed but you still need to push, create the PR, update labels, post the handoff comment, and write the workflow log. Continue immediately.\"}. If complete or stopped, respond {\"ok\": true}."
---

# /handoff <id> — Push, create PR, and hand off a Gitea issue

Automates the "Push + Create PR + Update issue" workflow.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Verify branch:** Run `git branch --show-current`. It must match `feature/issue-<id>-*`. If not, STOP: "Not on the expected feature branch for #<id>."

2. **Run quality gates** using the **Agent tool** (NOT the Skill tool — this MUST be a subagent to keep verbose output out of your context). Use this exact prompt:

   > Run quality gates for this project from the repo root. Read `CLAUDE.md` § Commands for the exact commands.
   > Run sequentially: lint → test → typecheck → build.
   > If all pass, run coverage on changed files vs main branch — flag any non-test source file at ≤5% line coverage.
   > See `.claude/skills/verify/SKILL.md` for full coverage gate details.
   >
   > Return ONLY this structured summary (5-15 lines max):
   > ```
   > LINT: pass | fail (N errors: <first 3>)
   > TEST: pass (N suites, M tests) | fail (N failed: <test names>)
   > TYPECHECK: pass | fail (<first 5 errors>) | skipped
   > BUILD: pass | fail (<error summary>)
   > COVERAGE: pass | fail (N files at 0%: <file list>) | skipped
   > OVERALL: pass | fail
   > ```

   **Do NOT invoke `/verify` via the Skill tool.** The Skill tool runs inline and dumps all verbose build/test output into your context, wasting tokens and risking context exhaustion before handoff. The Agent tool runs it in a subprocess and returns only the summary.

   **IMMEDIATELY when the subagent returns** (do NOT stop or end your turn):
   - If OVERALL: fail → STOP and report failures (do NOT fix — that's the caller's job).
   - If OVERALL: pass → continue to step 2b RIGHT NOW. The verify result is a mid-flow value, not a stopping point. You have 9 more steps to complete.

2b. **Check for remaining test stubs.**
   Search for `it.todo(` in all test files changed on this branch (use `git diff main --name-only -- '*.test.*'`).
   - If any `it.todo()` calls remain, STOP and report them:
     ```
     TEST STUBS: fail — N unimplemented test stubs remain
     - <file>: "<stub description>"
     - <file>: "<stub description>"
     ```
     These stubs were created from spec interactions during `/claim`. Each one must be implemented as a real test before handoff.
   - If none remain (or no test files changed), continue to step 2c.

2c. **Test coverage review (HARD GATE)** via an Explore subagent (keeps file reads out of main context):

   Launch an **Explore subagent** (Agent tool, `subagent_type: "Explore"`, thoroughness: "very thorough") with this prompt:

   > Do an exhaustive behavioral test gap analysis for all source files changed on this branch.
   >
   > 1. Run: `git diff main --name-only -- '*.ts' '*.tsx' | grep -v '\.test\.'` to get changed source files.
   > 2. For each source file, **read the actual source code** and identify every:
   >    - New function, method, or API endpoint
   >    - Conditional branch (if/else, switch, ternary) — especially error paths and edge cases
   >    - User interaction (button click, form submit, toggle, popover open/close)
   >    - API call with success/error handling
   >    - Fire-and-forget or async side effects
   >    - State transitions (enabled→disabled, open→closed, etc.)
   >    - DB persistence (new columns, new queries, create/update with new fields)
   > 3. Find the co-located test file (e.g., `foo.ts` → `foo.test.ts`) or parent component/integration test files. **Read each test file thoroughly** — don't just check it exists, read the actual assertions.
   > 4. Cross-reference: verify each behavior has an explicit test that asserts the specific outcome. Name the test. A test file existing is NOT sufficient — the specific behavior must be exercised and asserted.
   >
   > **Common gaps to watch for:**
   > - Route handlers with new fields passed through to services but never tested at the route level
   > - Fire-and-forget async operations (`.then().catch()`) — both success and failure paths
   > - UI components with new props/callbacks that have no interaction tests
   > - Toggle/mutation success and error toast messages
   > - Settings fetch failure fallback behavior
   > - Wiring files that pass new data through — verify parent integration tests cover the flow
   >
   > Return ONLY this structured checklist:
   > ```
   > COVERAGE REVIEW:
   > - <file>:
   >   - <behavior 1> → tested in <test file>: "<test name>" ✓
   >   - <behavior 2> → UNTESTED ✗ — <what bug this could catch>
   >
   > RESULT: pass | fail (N untested behaviors)
   > ```

   If RESULT is `fail` (any behavior marked UNTESTED) → STOP — write the missing tests in the main context, re-run `/verify`, then restart from step 2c. Do NOT proceed to push with untested behavior.

3. **Push the branch:**
   ```bash
   git push -u origin $(git branch --show-current)
   ```

4. **Read the issue** to get the title and details: `gitea issue $ARGUMENTS`

5. **Create the PR** via the Gitea API:
   - Write the PR body to a temp file (avoids shell escaping issues with multiline content):
   ```bash
   # Write PR body to temp file, then create PR
   gitea pr-create "#<id> <issue title>" --body-file <temp-file-path> "<branch-name>" "main"
   ```
   PR body template (write this to the temp file):
   ```
   Refs #<id>

   ## Summary
   - <bullet points of what changed>

   ## Acceptance Criteria
   - [ ] <from the issue spec>

   ## Tests / Verification
   - Commands: <what was run>
   - Manual: <what was checked>

   ## Risk / Rollback
   - Risk: low — <rationale>
   - Rollback: revert PR
   ```

6. **Update labels to `stage/review-pr`** (keeping all other existing labels):
   - Read the current labels from the issue output (step 4).
   - Replace any `stage/*` label with `stage/review-pr` (keep `status/in-progress` and all other labels).
   - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
   - Verify the output shows `stage/review-pr`.

7. **Post a handoff comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   gitea issue-comment <id> --body-file <temp-file-path>
   ```
   Comment template (write this to the temp file):
   ```
   **PR ready:** <PR link>

   - What changed:
       - ...
   - How verified:
       - ...
   - Notes / follow-ups:
       - None
   ```
   - Clean up the temp file after posting.

8. **Switch back to main:**
   ```bash
   git checkout main
   ```

9. **Continuous Learning retrospective** — before writing the workflow log, reflect on the implementation:

   a. **Read scratch context:** If `.claude/cl/scratch.md` exists, read it — this contains recent assistant context captured before compaction. Use it as supplementary memory for the retrospective steps below. (If the file doesn't exist, that's fine — proceed without it.)

   b. **Write learning files:** Reflect on the full implementation. Write a learning file to `.claude/cl/learnings/` for EVERY noteworthy item — things that surprised you, patterns that weren't obvious, gotchas you hit, constraints that aren't documented. No cap on count; capture everything worth knowing. Create the directory if it doesn't exist.
      - Filename: `.claude/cl/learnings/<short-slug>.md` (e.g., `fastify-inject-content-type.md`)
      - Format:
        ```yaml
        ---
        scope: [<matching issue scope labels, e.g. frontend, backend, core>]
        files: [<relevant files>]
        issue: <id>
        date: <YYYY-MM-DD>
        ---
        <One or two sentences: what you learned, why it matters, and what would have prevented the friction.>
        ```

   c. **Log debt observations:** If you noticed anything out of scope that needs fixing (bad patterns, missing tests, poor abstractions, confusing naming), append one-liner bullets to `.claude/cl/debt.md`. Create the file with a `# Technical Debt` heading if it doesn't exist. Format: `- **<file or area>**: <what's wrong and why it matters> (discovered in #<id>)`

   d. **Rank top 3:** Ask yourself: "What are 3 things I wish I'd known before starting this issue?" Write these to a `### Wish I'd Known` section in the workflow log entry (step 10). Reference the full learning files from 9b where applicable.

   e. **Delete scratch file:** If `.claude/cl/scratch.md` exists, delete it — it's been consumed.

   f. **Verify capture (HARD GATE):** Before proceeding to step 10, verify:
      - `.claude/cl/learnings/` exists and contains at least one `.md` file with `issue: <id>` in its frontmatter — OR the workflow log entry (step 10) explicitly states under `### Wish I'd Known` why zero learnings were captured (e.g., "Trivial issue with no surprises — no learnings to capture").
      - If debt was discovered during implementation (fix iterations, dead code, out-of-scope issues found while reading code), `.claude/cl/debt.md` exists and contains at least one entry referencing `#<id>`.
      - If either check fails, STOP and complete the missing capture before continuing. Do NOT skip this step — it is the safety net for mid-implementation capture being skipped (which happens reliably).

10. **Prepend to workflow log** (`.claude/cl/workflow-log.md`) — add a new entry at the **top** of the file (below the `# Workflow Log` heading), so entries are reverse-chronological. If the file doesn't exist, create it with the heading first.

   Entry format:
   ```
   ## #<id> <issue title> — <YYYY-MM-DD>
   **Skill path:** /implement → /claim → /plan → /handoff
   **Outcome:** success — PR #<number>

   ### Metrics
   - Files changed: <N> | Tests added/modified: <N>
   - Quality gate runs: <N> (pass on attempt <N>)
   - Fix iterations: <N> (what failed and how it was fixed)
   - Context compactions: <N> (did any cause rework?)

   ### Workflow experience
   - What went smoothly: <what worked well>
   - Friction / issues encountered: <problems hit during implementation — be specific about root causes>

   ### Token efficiency
   - Highest-token actions: <what consumed the most context>
   - Avoidable waste: <what could have been done better>
   - Suggestions: <lessons for next time>

   ### Infrastructure gaps
   - Repeated workarounds: <patterns you worked around more than once, or known workarounds from prior sessions>
   - Missing tooling / config: <things that should exist but don't>
   - Unresolved debt: <tech debt introduced or discovered — things that need future attention>

   ### Wish I'd Known
   1. <most impactful thing you wish you'd known before starting>
   2. <second most impactful>
   3. <third most impactful>
   ```

11. Tell the user the PR is created and show the link.

   **If called as a sub-skill** (e.g., from `/implement`): append `CALLER: Sub-skill complete. Continue to your next step immediately.` to your output.
