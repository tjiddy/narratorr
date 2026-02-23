---
name: review-pr
description: Review a PR against its linked issue's acceptance criteria. Posts structured
  findings with verdict, auto-merges on approve. Use when user says "review PR",
  "review pull request", or invokes /review-pr.
argument-hint: <pr-number>
disable-model-invocation: true
---

# /review-pr <pr-number> — Review a pull request against its linked issue

Reviews a PR by checking the diff against the linked issue's acceptance criteria, the project's design principles, and code quality standards. Posts a structured review comment with machine-parseable findings.

**Review policy: high recall.** Prefer false positives over missed defects. The cost of a PR author dismissing a noisy suggestion is far lower than the cost of a bug reaching main. Do not cap the number of findings — report everything you find. Use `suggestion` liberally for anything that *might* matter; reserve `blocking` strictly for issues backed by concrete evidence (broken behavior, missing tests for new code paths, verified design violations). No speculative blockers — if you can't point to a specific line and a specific consequence, it's a suggestion.

## Gitea CLI

All Gitea commands use: `node scripts/gitea.ts` (referred to as `gitea` below).

## Steps

1. **Fetch PR details:** Run `gitea pr <pr-number>`. Extract:
   - Title, body, state, head branch, base branch, **author** (`author: <login>` in output), labels
   - Linked issue: parse `Refs #<id>` from PR body

2. **Self-review guard:** Run `gitea whoami` to get your authenticated username. Compare against the PR author from step 1.
   - If your username **matches** the PR author → **STOP**: "Cannot review your own PR. The authenticated user (`<username>`) is the PR author. Run `/review-pr <pr>` from a session authenticated as a different Gitea user (e.g., the reviewer account)."
   - Before stopping, consider: did the user actually want `/respond-to-pr-review <pr>` instead? If the PR already has review comments with findings from another user, the user likely wants the author to address those findings — suggest `/respond-to-pr-review <pr>` in your stop message.
   - If they differ → proceed (you are a different user than the author).

3. **Read linked issue:** Run `gitea issue <id>`. Extract the **Acceptance Criteria** section.

4. **Read project's CLAUDE.md:** Read the `CLAUDE.md` file in the repository root. Extract:
   - Design principles (SRP, DRY, Open/Closed, co-location, etc.)
   - Code style conventions (TypeScript strict, ESM, path aliases, etc.)
   - Logging conventions (levels, where to log, `FastifyBaseLogger`)
   - Testing conventions (co-located tests, required patterns)
   - Any project-specific rules the review must enforce

5. **Fetch the diff:**
   ```bash
   git fetch origin main <head-branch>
   git diff origin/main...<head-branch>
   ```
   Use `origin/main` (not local `main`) to avoid false positives from stale local state. The three-dot syntax shows only changes introduced on the branch.

5b. **Read prior review history:** Run `gitea pr-comments <pr-number>`. Parse ALL comments containing `## Verdict:` (prior reviews) and `## Review Response` (author responses). Build a map of prior findings and their resolutions:
   - For each prior finding ID (F1, F2, etc.), note: the original finding, the author's resolution (`fixed`, `accepted`, `disputed`), and any rationale provided.
   - **This context is mandatory for re-reviews.** If this is the first review (no prior `## Verdict:` comments), skip to step 6.
   - **This does NOT reduce the scope of the review.** Steps 6-9 still run in full — you may find net-new issues that prior rounds missed. The prior history only affects how you handle findings that overlap with previously-disputed items (see dispute engagement rules below).

   **Dispute engagement rules** — these apply in step 11 when classifying findings. After completing the full review (steps 6-9), check each finding against the prior history map:
   - If a finding was previously raised and the author **fixed** it, verify the fix addresses the issue. If it does, drop the finding. If the fix is incomplete or introduces new problems, raise a NEW finding explaining what's still wrong (don't re-raise the old one verbatim).
   - If a finding overlaps with something the author previously **disputed** with rationale (code references, tool output, docs, test results), you MUST engage with their specific argument before re-raising it. You have three options:
     1. **Withdraw** — the author's rationale is correct. Drop the finding entirely.
     2. **Rebut** — the author's rationale is wrong. Raise the finding again with a NEW reason that directly addresses and refutes their argument. Explain specifically why their evidence doesn't hold. "The spec says X" is not a rebuttal if the author demonstrated X is technically impossible.
     3. **Refine** — the author's rationale is partially correct but misses something. Raise a narrower or modified finding that accounts for their point.
   - **Re-raising a finding with the same description and reason after it was disputed is NOT allowed.** If you can't produce a concrete rebuttal to the author's specific argument, withdraw the finding. Repeating yourself is not reviewing — it's a bug.
   - If a finding was previously raised and the author **accepted** it (suggestion severity), it's resolved — don't re-raise.
   - If a finding was previously raised and the author **deferred** it to a new issue, it's resolved — don't re-raise.
   - **Net-new findings are always welcome.** The dispute rules only constrain re-raised findings. If the full review surfaces something genuinely new that wasn't in any prior round, raise it normally regardless of prior history.

6. **Check each AC criterion against the diff:**
   - For each acceptance criterion, determine: `pass` | `partial` | `missing`
   - Note specific files/lines that address each criterion

7. **Check common issues:**
   - Missing tests for new functionality
   - Missing error handling / logging in catch blocks
   - Scope creep (changes not related to the issue)
   - Missing logging on CRUD operations or external API calls
   - Security concerns (injection, unsanitized input)

7b. **Test quality review** — Go beyond "do tests exist" and evaluate whether they actually catch defects:
   - **Mock realism:** Does mock data actually exercise the code path? Watch for mocks that return perfect happy-path objects when the test should verify handling of missing/optional fields.
   - **Assertion specificity:** Flag lazy assertions — `toHaveBeenCalled()` without checking args, `toBeInTheDocument()` matching coincidental text. Assertions should verify the *right* thing happened, not just *something* happened.
   - **Tests that can't fail:** Would the test still pass if the feature code was deleted? Tests that assert initial state (e.g., "Loading" text that's always there on first render) without waiting for a state transition catch nothing.
   - **Mock leakage:** Missing `clearAllMocks` in `beforeEach`, module-level mock state that persists between tests, test ordering dependencies.
   - **Flaky patterns:** Timing-dependent assertions without `waitFor`, non-deterministic test data (random IDs, `Date.now()`), assertions that depend on execution order rather than explicit state setup.
   - Consult the project's CLAUDE.md for test quality standards and the project philosophy on test value vs noise.

8. **Architecture review** — Check the diff against project design principles. **Every violation found here MUST become a finding in step 11** — do not note violations in the table without generating corresponding findings.
   - **SRP**: Does each new/modified file have one reason to change? Are concerns mixed?
   - **DRY**: Is there duplicated logic that should be extracted?
   - **Open/Closed**: Does adding this feature require modifying growing lists in existing files? Should there be a registry pattern?
   - **Co-location**: Are types next to their API methods? Components next to their hooks?
   - **Consistency**: Does the new code follow existing patterns in the codebase? (naming, file structure, error handling style)
   - **Over-engineering**: Are there unnecessary abstractions, premature generalizations, or feature flags for one-time operations?

   **Lint-level code smells** (`var`, explicit `any`, unused variables, unjustified `eslint-disable`): CI gates own this layer — `pnpm lint` and `pnpm typecheck` catch these as hard errors. The reviewer does NOT need to flag them unless CI is passing despite the issue (indicating a gap in the lint config).

9. **UI/UX design check** — If the issue has `scope/frontend` or the diff includes new/changed UI components (`.tsx` files with JSX):
   - Check if the implementation appears to have gone through a design refinement pass (polished styling, consistent with existing UI patterns, not just bare functional markup)
   - If new UI components look unpolished or inconsistent with the app's design language, flag as a blocking finding with category `"ui-design"` — the author should run the `frontend-design` skill before merge
   - If no frontend changes, skip this step

10. **Nitpick filter** — Do NOT flag these as findings:
   - Style preferences ("I would have named it differently")
   - Naming opinions unless inconsistent with existing codebase conventions
   - Formatting or whitespace
   - "I would have done it differently" without a concrete technical reason
   - TODO comments that are tracked by Gitea issues
   - Import ordering
   - Minor variable naming within a function body
   - Adding comments to obvious code

11. **Classify findings** — For **every** issue found in steps 6-9 (including 7b), create a finding entry and assign a `severity` value. Do not cap the number of findings — report everything you find. **Audit yourself**: re-read the Architecture Review table from step 8 and the test quality checks from step 7b. If any row says "violation" or any test quality issue was noted, there MUST be a corresponding finding below. An issue noted in a table but absent from findings is a review defect.
    - **`"blocking"`**: Must fix before merge. Bugs, missing AC, security issues, missing tests for new behavior, clear design principle violations (SRP, DRY, Open/Closed). Blocking findings must be evidence-based — point to a specific line and a specific consequence (broken behavior, untested code path, verified principle violation). No speculative blockers: "this *might* cause issues in the future" is a suggestion, not a blocker.
    - **`"suggestion"`**: Worth considering but not a merge blocker. Use liberally across: minor improvements, alternative approaches, potential future issues, test quality gaps, maintainability concerns, observability/logging gaps, naming clarity, and future regression risk. When in doubt about severity, make it a suggestion.
    - Do NOT use other severity terms like "high", "medium", "low", "critical" — only `"blocking"` or `"suggestion"`. This is consumed by `/respond-to-pr-review` which has different resolution rules per severity.
    - Every finding MUST include a concrete "why" — what breaks, what's inconsistent, what principle is violated. No vague "this could be better."

    **Prior-round deduplication (mandatory for re-reviews):**
    - Before finalizing findings, cross-reference each finding against the prior finding map from step 5b.
    - If a finding matches one that was previously `fixed`, verify the fix in the current diff. If fixed, do not re-raise. If the fix is incomplete or wrong, raise a new finding with a description that explains what the fix missed.
    - If a finding matches one that was previously `disputed`, apply the dispute engagement rules from step 5b. You MUST either withdraw it or raise it with a substantively different reason that rebuts the author's argument. Copy-pasting the old finding is a review defect.
    - Include a `## Prior Findings` section in the review comment (see template in step 12) that explicitly states the disposition of each previously-raised finding: `withdrawn`, `verified-fixed`, or `re-raised (rebuttal: ...)`. This creates an audit trail and forces you to account for every prior finding.

12. **Post review comment on PR:**
    - Write comment to temp file, then: `gitea pr-comment <pr-number> --body-file <temp-file-path>`
    - Template:
      ```
      ## AC Review

      | Criterion | Status | Notes |
      |-----------|--------|-------|
      | <AC item> | pass/partial/missing | <details> |

      ## Code Review

      - Tests: pass | missing (<what's missing>)
      - Error handling: pass | missing (<where>)
      - Logging: pass | missing (<where>)
      - Scope: clean | creep (<what>)
      - Security: pass | concern (<what>)

      ## Architecture Review

      - SRP: pass | violation (<what file mixes concerns>)
      - DRY: pass | violation (<what's duplicated>)
      - Open/Closed: pass | violation (<what requires modification>)
      - Co-location: pass | violation (<what's misplaced>)
      - Consistency: pass | inconsistent (<what pattern is broken>)
      - Over-engineering: pass | concern (<what's unnecessary>)

      ## Prior Findings (omit on first review)

      | Prior ID | Original Description | Disposition |
      |----------|---------------------|-------------|
      | F1 (round 1) | <description> | verified-fixed / withdrawn / re-raised as F<N> (rebuttal: <why author's argument doesn't hold>) |

      ## Verdict: approve | needs-work

      <Summary — what needs to change, if anything>

      ## Findings

      ```json
      [
        {
          "id": "F1",
          "severity": "blocking",
          "category": "tests|test-quality|ac|security|architecture|logging|error-handling|scope|ui-design",
          "file": "path/to/file.ts",
          "line": 42,
          "description": "Short description of the issue",
          "reason": "Concrete why — what breaks or what principle is violated"
        }
      ]
      ```
      ```
    - Clean up temp file

13. **Decision branch after posting review:**

    **If verdict is `approve`:**
    - Invoke `/merge <pr-number>` to squash merge, update issue labels, and clean up the branch
    - If merge fails, report the error — do not retry

    **If verdict is `needs-work`:**
    - **STOP.** Do not attempt to fix anything — that's the author's job via `/respond-to-pr-review`
    - Report findings to the main agent and wait for human to trigger the next cycle

14. **Report to main agent:** Overall verdict + outcome (merged or awaiting author response).

## Important

- If no `Refs #<id>` found in PR body, ask the user which issue to review against
- The diff can be large — focus on changed files, not the entire codebase
- Be constructive — flag real issues, not style preferences. But err on the side of reporting: a dismissed suggestion costs the author 10 seconds, a missed defect costs a full review cycle.
- The `## Findings` JSON block is consumed by `/respond-to-pr-review` — ensure it is valid JSON with `severity` values of exactly `"blocking"` or `"suggestion"` (no other terms)
- An `approve` verdict means zero blocking findings. Any blocking finding → `needs-work`
- If there are no findings at all, use an empty array: `[]`
- **Re-reviews require prior comment reading.** On any PR that already has `## Verdict:` comments, step 5b is mandatory. Skipping it produces review loops where the same finding bounces back and forth. The author has done work to address your findings — respect that by reading their response before re-reviewing.
- **Stand your ground when you're right.** If the author disputes a finding and their rationale is wrong, rebut it with specific evidence. Don't withdraw just because they pushed back — withdraw because they proved you wrong. But if they DID prove you wrong (showed the code works, demonstrated a tool produces no output, cited docs), have the intellectual honesty to drop it.
