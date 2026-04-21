---
name: handoff
description: Push changes, create a PR, and hand off a GitHub issue. Runs quality
  gates, posts handoff comment, updates labels, and captures learnings. Use when user
  says "hand off", "create PR", "submit for review", or invokes /handoff.
argument-hint: <issue-id>
hooks:
  Stop:
    - hooks:
        - type: command
          command: "node scripts/hooks/stop-gate.ts handoff"
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/workflow.md`

!`cat .claude/docs/design-principles.md`

# /handoff <id> — Push, create PR, and hand off a GitHub issue

Automates the "Push + Create PR + Update issue" workflow.

## GitHub CLI

All GitHub commands use: `node scripts/gh.ts` (referred to as `gh` below).

## Steps

0. **Initialize stop-gate state:** `mkdir -p .narratorr/state/handoff-<id>/`

1. **Verify branch:** Run `git branch --show-current`. It must match `feature/issue-<id>-*`. If not, write `mkdir -p .narratorr/state/handoff-<id> && echo done > .narratorr/state/handoff-<id>/stopped` then STOP: "Not on the expected feature branch for #<id>."

2. *(Removed — self-review subagent was 0-for-5 on actionable findings across recent PRs. External Codex reviewer is the quality gate.)*

2b. **Write phase marker:** `mkdir -p .narratorr/state/handoff-<id> && echo done > .narratorr/state/handoff-<id>/self-review-complete`

3. **Check for remaining test stubs.**
   Search for `it.todo(` in all test files changed on this branch (use `git diff main --name-only -- '*.test.*'`).
   - If any `it.todo()` calls remain, STOP and report them:
     ```
     TEST STUBS: fail — N unimplemented test stubs remain
     - <file>: "<stub description>"
     - <file>: "<stub description>"
     ```
     These stubs were created from spec interactions during `/claim`. Each one must be implemented as a real test before handoff.
   - If none remain (or no test files changed), continue to step 4.

4. **Test coverage check (HARD GATE)** — deterministic, not LLM-based.

   Run `pnpm exec vitest run --coverage` and check that every changed source file has a co-located test file:
   ```bash
   # List changed source files without tests. Exempt:
   #  - .test.ts / .test.tsx (vitest tests)
   #  - .spec.ts / .spec.tsx (Playwright specs — self-testing)
   #  - .config.ts / .config.tsx (tool/framework configs)
   for f in $(git diff main --name-only -- '*.ts' '*.tsx' \
               | grep -vE '\.(test|spec)\.(ts|tsx)$' \
               | grep -vE '\.config\.(ts|tsx)$'); do
     testfile="${f%.ts}.test.${f##*.}"
     testfile2="${f%.tsx}.test.${f##*.}"
     if [ ! -f "$testfile" ] && [ ! -f "$testfile2" ]; then
       echo "MISSING TEST: $f"
     fi
   done
   ```
   - If any source file is missing a co-located test file, STOP and write the tests.
   - Files that are pure re-exports, barrel `index.ts` files, or type-only files are exempt.
   - `*.spec.ts` files are treated as tests (Playwright convention) — they ARE tests, no co-location required.
   - `*.config.ts` / `*.config.tsx` files are exempt — tool/framework configs (`vitest.config.ts`, `playwright.config.ts`, `drizzle.config.ts`, etc.) don't ship co-located unit tests.
   - Harness helpers under `e2e/fixtures/` and `e2e/*.ts` (non-spec, non-config) DO need co-located `.test.ts` coverage — vitest is configured to scan `e2e/fixtures/**/*.test.ts` and `e2e/*.test.ts` so these tests run as part of `pnpm test`.
   - This replaces the previous Explore subagent which had a ~75% false positive rate and missed entire test files.

4b. **Write phase marker:** `mkdir -p .narratorr/state/handoff-<id> && echo done > .narratorr/state/handoff-<id>/coverage-complete`

5. **Run quality gates** by executing: `node scripts/verify.ts`

   This is a script, not an LLM call — it runs lint → test+coverage → typecheck → build and returns a one-line summary on success or structured failures.

   - If output starts with `VERIFY: fail` → STOP and report failures (do NOT fix — that's the caller's job).
   - If output starts with `VERIFY: pass` → write phase marker: `mkdir -p .narratorr/state/handoff-<id> && echo done > .narratorr/state/handoff-<id>/verify-complete` and continue to step 6 immediately.

6. **Pre-push audit:** Run `git status` and inspect the output for untracked or modified files that should have been committed — especially in `drizzle/`, `src/`, and `scripts/`. If you find uncommitted artifacts from your changes (e.g., migration meta files, generated code), stage and commit them before pushing. This catches files that `verify.ts` can't detect because they only matter in a clean checkout (like CI).

7. **Push the branch:**
   ```bash
   node scripts/git-push.ts -u origin $(git branch --show-current)
   ```

7. **Read the issue** to get the title and details: `node scripts/gh.tsissue view $ARGUMENTS --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'`

8. **Create the PR** via the GitHub CLI:
   - Write the PR body to a temp file (avoids shell escaping issues with multiline content):
   - **Do NOT pass `--label` to `gh pr create`.** `Closes #<id>` goes in the PR body (the temp file), not as a label. Passing it as `--label` creates junk labels named "Closes #N".
   ```bash
   # Write PR body to temp file, then create PR
   node scripts/gh.ts pr create --title "#<id> <issue title>" --body-file <temp-file-path> --head "<branch-name>" --base main
   ```
   PR body template (write this to the temp file):
   ```
   Closes #<id>

   ## Summary
   - <bullet points of what changed>

   ## Acceptance Criteria
   - [x] <implemented in this PR — cite file:line>
   - [x] <already on main — cite file:line evidence proving the behavior works>

   NOTE: Every AC must have a disposition. If an AC is "already done on main,"
   you MUST cite the specific file:line that proves it. Do NOT write "already
   implemented" without evidence — the reviewer will verify each claim and
   reject unproven ones as blocking findings.

   ## Tests / Verification
   - Commands: <what was run>
   - Manual: <what was checked>

   ## Risk / Rollback
   - Risk: low — <rationale>
   - Rollback: revert PR
   ```

9. **Update labels:**
   - Set `stage/review-pr` on the **PR**: `node scripts/update-labels.ts <pr-number> --pr --replace "stage/" "stage/review-pr"`
   - Set `status/in-review` on the **issue**: `node scripts/update-labels.ts <id> --replace "status/" "status/in-review"`
   - Verify the PR output shows `stage/review-pr` and the issue output shows `status/in-review`.

10. **Post a handoff comment** on the issue:
   - Write the comment to a temp file, then post it:
   ```bash
   node scripts/gh.ts issue comment <id> --body-file <temp-file-path>
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

11. **Continuous Learning retrospective** — reflect on the implementation:

   a. **Read scratch context:** If `.narratorr/cl/scratch.md` exists, read it — this contains recent assistant context captured before compaction. Use it as supplementary memory for the retrospective steps below. (If the file doesn't exist, that's fine — proceed without it.)

   b. **Write learning files:** Reflect on the full implementation. Write a learning file to `.narratorr/cl/learnings/` for EVERY noteworthy item — things that surprised you, patterns that weren't obvious, gotchas you hit, constraints that aren't documented. No cap on count; capture everything worth knowing. Create the directory if it doesn't exist.
      - Filename: `.narratorr/cl/learnings/<short-slug>.md` (e.g., `fastify-inject-content-type.md`)
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

   c. **Log debt observations:** If you noticed anything out of scope that needs fixing (bad patterns, missing tests, poor abstractions, confusing naming), append one-liner bullets to `.narratorr/cl/debt.md`. Create the file with a `# Technical Debt` heading if it doesn't exist. Format: `- **<file or area>**: <what's wrong and why it matters> (discovered in #<id>)`. **Dedup check:** Before appending, read the existing debt file and check if the same issue is already logged (same file/area and same problem). If it is, do NOT add a duplicate entry — the existing entry is sufficient regardless of which issue discovered it first.

   d. **Delete scratch file:** If `.narratorr/cl/scratch.md` exists, delete it — it's been consumed.

   e. **Verify capture (HARD GATE):** Before proceeding, verify:
      - `.narratorr/cl/learnings/` exists and contains at least one `.md` file with `issue: <id>` in its frontmatter — OR you have explicitly decided there are no learnings worth capturing (e.g., "Trivial issue with no surprises").
      - If debt was discovered during implementation (fix iterations, dead code, out-of-scope issues found while reading code), `.narratorr/cl/debt.md` exists and contains at least one entry referencing `#<id>`.
      - If either check fails, STOP and complete the missing capture before continuing. Do NOT skip this step — it is the safety net for mid-implementation capture being skipped (which happens reliably).

<!-- DISABLED (workflow log retired — CL process winding down on this project, re-enable for next project spin-up):

   d. **Rank top 3:** Ask yourself: "What are 3 things I wish I'd known before starting this issue?" Write these to a `### Wish I'd Known` section in the workflow log entry (step 12). Reference the full learning files from 11b where applicable.

12. **Prepend to workflow log** (`.narratorr/cl/workflow-log.md`) — add a new entry at the **top** of the file (below the `# Workflow Log` heading), so entries are reverse-chronological. If the file doesn't exist, create it with the heading first.

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
-->

12. **(reserved — workflow log step retired; see comment above)**

13. **Commit and push CL files:** The learning files and debt log written in step 11 are on the feature branch. Commit and push so they land on main with the PR merge:
    ```bash
    git add .narratorr/cl/
    git commit -m "CL from #<id>"
    node scripts/git-push.ts origin <branch-name>
    ```
    If there's nothing to commit (no new CL files), skip this step.

14. **Write final phase marker and clean up:** `mkdir -p .narratorr/state/handoff-<id> && echo done > .narratorr/state/handoff-<id>/pr-created`
    - Then clean up state: `rm -rf .narratorr/state/handoff-<id>/`

16. Tell the user the PR is created and show the link.
