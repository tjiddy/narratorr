---
name: review-pr
description: Review a PR against its linked issue's acceptance criteria. Posts structured
  findings with verdict, auto-merges on approve. Use when user says "review PR",
  "review pull request", or invokes /review-pr.
argument-hint: <pr-number>
disable-model-invocation: true
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: "The agent is running /review-pr (explore code → evaluate → post verdict comment → set labels → merge or stop). Check its last message. It is DONE only if it contains '## Verdict:' AND '## Exhaustiveness: complete' AND '## Depth Coverage: complete' AND confirms the comment was posted to Gitea AND labels were updated, or an explicit STOP/block condition. If the last message contains review findings or a verdict that hasn't been posted to Gitea yet (no gitea issue-comment or gitea pr-comment confirmation), or if exhaustiveness/depth coverage is missing, respond {\"ok\": false, \"reason\": \"Review incomplete. You must prove exhaustive file coverage and behavioral depth coverage, post the review comment to Gitea, and update labels before stopping.\"}. If complete or blocked, respond {\"ok\": true}."
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

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
   git diff --name-status origin/main...<head-branch>
   ```
   Use `origin/main` (not local `main`) to avoid false positives from stale local state. The three-dot syntax shows only changes introduced on the branch.

5b. **Read prior review history:** Run `gitea pr-comments <pr-number>`. Parse ALL comments containing `## Verdict:` (prior reviews) and `## Review Response` (author responses). Build a map of prior findings and their resolutions:
   - For each prior finding ID (F1, F2, etc.), note: the original finding, the author's resolution (`fixed`, `accepted`, `disputed`), and any rationale provided.
   - **This context is mandatory for re-reviews.** If this is the first review (no prior `## Verdict:` comments), skip to step 6.
   - **This does NOT reduce the scope of the review.** Steps 5-8 still run in full — you may find net-new issues that prior rounds missed. The prior history only affects how you handle findings that overlap with previously-disputed items (see dispute engagement rules below).

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

5c. **Build changed-file review inventory (MANDATORY):**
   - From `git diff --name-status origin/main...<head-branch>`, build a `changed_files` list.
   - Classify each file as exactly one of:
     - `reviewed` (inspected during steps 6-9),
     - `skipped-generated` (lockfiles, generated artifacts, snapshots, etc.),
     - `skipped-nonruntime` (docs-only or metadata-only files).
   - Every changed code file (`.ts`, `.tsx`, `.js`, `.jsx`, schema/migration/runtime config) MUST be `reviewed`.
   - If any changed code file is not reviewed, **STOP** and continue reviewing before producing verdict.

5d. **Enumerate behavior deltas per reviewed code file (MANDATORY):**
   - For each `reviewed` changed code file, enumerate all new/modified behaviors introduced by the diff:
     - Branches/conditionals (including precedence logic),
     - Error paths and fallback paths,
     - State transitions and side effects,
     - Input/output contract changes (request fields, response fields, optional fields),
     - Caching/invalidation behavior.
   - Create a `Behavior Coverage` table entry per behavior with:
     - `id` (B1, B2, ...),
     - `file`,
     - `behavior`,
     - `status`: `finding(F#)` or `verified-correct (evidence)`.
   - A behavior listed as `verified-correct` must cite concrete evidence (code path and/or test assertion). "Looks fine" is invalid.
   - If any reviewed code file lacks behavior entries, review is incomplete.

5e. **Enumerate interaction intersections (MANDATORY):**
   - Build an `Interaction Checks` list for feature intersections touched by the PR (for example: precedence combinations, config-save shape x invalidation logic, route serialization x service response shape, fallback x retry).
   - For each intersection, record:
     - `interaction`,
     - `checked evidence`,
     - `result`: `finding(F#)` or `verified-correct`.
   - If a changed feature has at least one plausible intersection and none are checked, review is incomplete.

5f. **Enumeration quality examples (use this granularity):**
   - These are illustrative patterns, not an exhaustive checklist.
   - Do NOT limit review to these examples; enumerate additional behaviors/intersections introduced by the current PR.
   - **Good behavior entries (specific, testable, branch-level):**
     - `settings.ts`: "Cache invalidation runs only when `network` values changed, not when unchanged `network` is present in full-form payload."
     - `newznab.ts`: "`test()` suppresses proxy `ip` reporting when `flareSolverrUrl` is configured (precedence)."
     - `indexers routes`: "Both test endpoints preserve optional `ip` field in serialized response."
   - **Bad behavior entries (too broad, non-falsifiable):**
     - "Handles settings correctly."
     - "Proxy logic works."
     - "Routes look fine."
   - **Good interaction entries (explicit intersection):**
     - "FlareSolverr precedence x proxy IP reporting."
     - "Full settings payload shape x network cache invalidation condition."
     - "Service return shape (`ip?`) x route response serialization."
   - **Bad interaction entries (missing intersection dimension):**
     - "Checked FlareSolverr."
     - "Checked settings."
     - "Checked tests."

6. **Check each AC criterion against the diff:**
   - For each acceptance criterion, determine: `pass` | `partial` | `missing`
   - Note specific files/lines that address each criterion
   - Ensure each reviewed changed code file maps to at least one AC item or an explicit scope-creep/security/test-quality observation.

7. **Check common issues:**
   - Missing error handling / logging in catch blocks
   - Scope creep (changes not related to the issue)
   - Missing logging on CRUD operations or external API calls
   - Security concerns (injection, unsanitized input)

7a. **Behavioral test gap analysis** — For every changed source file in the diff, verify that each new behavior has a corresponding test assertion (not just a test file):
   - **Route handlers:** Every new endpoint, query param, body field, status code, and error path must have a route-level integration test (`app.inject()`)
   - **Service methods:** Every new method, query filter, and business logic branch must have a service-level test
   - **Fire-and-forget paths:** Async `.then().catch()` chains must have tests for both success and failure
   - **UI components:** Every new prop, callback, toggle state, and user interaction (click, submit, toggle) must have an interaction test with `userEvent`
   - **Mutations:** Success toast, error toast, and query invalidation must each be tested
   - **Settings/config:** Fetch failure fallback behavior must be tested (what happens when settings API fails?)
   - **DB persistence:** New columns passed through create/update must be tested at the route level (not just "service was called" — verify the field is in the call args)

   Flag any behavior that exists in source but has no test as a **blocking** finding with category `"tests"`. The finding must name the specific untested behavior and explain what bug it could catch.

7b. **Test quality review** — Go beyond "do tests exist" and evaluate whether they actually catch defects:
   - **Mock realism:** Does mock data actually exercise the code path? Watch for mocks that return perfect happy-path objects when the test should verify handling of missing/optional fields.
   - **Assertion specificity:** Flag lazy assertions — `toHaveBeenCalled()` without checking args, `toBeInTheDocument()` matching coincidental text. Assertions should verify the *right* thing happened, not just *something* happened.
   - **Tests that can't fail:** Would the test still pass if the feature code was deleted? Tests that assert initial state (e.g., "Loading" text that's always there on first render) without waiting for a state transition catch nothing.
   - **Mock leakage:** Missing `clearAllMocks` in `beforeEach`, module-level mock state that persists between tests, test ordering dependencies.
   - **Flaky patterns:** Timing-dependent assertions without `waitFor`, non-deterministic test data (random IDs, `Date.now()`), assertions that depend on execution order rather than explicit state setup.
   - Consult the project's CLAUDE.md for test quality standards and the project philosophy on test value vs noise.

8. **Architecture review** — Check the diff against the mechanical checks in `.claude/docs/architecture-checks.md`. **Every violation found here MUST become a finding in step 11** — do not note violations in the table without generating corresponding findings.

   **Always check (every PR):**
   - **OCP-1 (Wiring Cost):** Does the PR add a new type variant? Count files touched just for type registration (enums, schemas, constants, factories). If >3 files, flag as `suggestion` with the registry pattern recommendation. If >5, flag as `blocking`.
   - **OCP-2 (Growing Switch):** Does the PR add new cases to an existing switch/case or if/else chain on a type discriminator? Count total cases after the change. If >4 cases and the same discriminator is switched on in 2+ files, flag as `suggestion`.
   - **LSP-1 (Interface Contract):** Does any new implementation return null/empty/no-op where sibling implementations return real data? Check if callers branch on the null to determine behavior. If yes, flag as `blocking` — the interface contract is broken.
   - **DRY-1 (Parallel Types):** Does the PR add the same string literal (type name, enum value) to 4+ files? Flag as `suggestion`.

   **Check when adding new types/adapters:**
   - **OCP-3 (Conditional Rendering):** Does the PR add new if/else branches for type-specific UI rendering? Flag as `suggestion` if a component map pattern exists elsewhere in the codebase (e.g., `NotifierFields.tsx`).
   - **LSP-2 (Error Contracts):** Do implementations of the same interface use different error strategies (one throws, another returns null)? Flag as `blocking` if callers only handle one pattern.

   **Check when modifying services:**
   - **SRP-1 (Side-Effect Breadth):** Does any new/modified function touch 3+ side-effect categories (DB write, HTTP call, file I/O, event emission, notification)? Flag as `suggestion`.
   - **SRP-2 (God Service):** Does the modified service now exceed 15 public methods or 500 lines? Flag as `suggestion`.
   - **ISP-1 (Fat Injection):** Does a function receive a large dependency object (e.g., full `Services`) but only use a subset? Flag as `suggestion` if <50% of deps are used.

   **Check when modifying routes:**
   - **SRP-3 (Route Logic):** Does a route handler contain business logic beyond parse/call/respond? Flag as `suggestion`.
   - **ARCH-3 (Entity Leakage):** Does the route return raw DB rows without transformation? Flag as `suggestion`, or `blocking` if sensitive fields could leak.

   **Additional design checks (not from the checks doc):**
   - **Co-location**: Are types next to their API methods? Components next to their hooks?
   - **Consistency**: Does the new code follow existing patterns in the codebase?
   - **Over-engineering**: Are there unnecessary abstractions, premature generalizations, or feature flags for one-time operations?

   **Lint-level code smells** (`var`, explicit `any`, unused variables, unjustified `eslint-disable`): CI gates own this layer — `pnpm lint` and `pnpm typecheck` catch these as hard errors. The reviewer does NOT need to flag them unless CI is passing despite the issue (indicating a gap in the lint config).

9. **UI/UX design check** — If the issue has `scope/frontend` or the diff includes new/changed UI components (`.tsx` files with JSX):
   - Check if the implementation appears to have gone through a design refinement pass (polished styling, consistent with existing UI patterns, not just bare functional markup)
   - If new UI components look unpolished or inconsistent with the app's design language, flag as a blocking finding with category `"ui-design"` — the author should run the `frontend-design` skill before merge
   - If no frontend changes, skip this step

9b. **Exhaustiveness and depth gate (MANDATORY before step 10):**
   - Produce a `File Coverage` table that includes every entry from `changed_files` with: `path`, `status` (`reviewed|skipped-generated|skipped-nonruntime`), and `notes`.
   - For each `reviewed` file, record either:
     - at least one finding ID touching that file, or
     - explicit note `no issues found`.
   - Produce `Behavior Coverage` and `Interaction Checks` sections from steps 5d/5e.
   - If any changed file is missing from `File Coverage`, any changed code file is skipped, any enumerated behavior lacks disposition, or interaction checks are missing for touched feature intersections, the review is incomplete and MUST NOT produce a verdict.

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
    - Cross-check the `File Coverage` table from step 9b: every `reviewed` file must appear in findings and/or be explicitly recorded as `no issues found`.
    - Cross-check `Behavior Coverage`: every behavior ID must map to either a finding or `verified-correct` evidence.
    - Cross-check `Interaction Checks`: each checked intersection must map to either a finding or `verified-correct` evidence.

12. **Post review comment on PR (MANDATORY — this is a Gitea API call, not stdout):**
    - Write comment to temp file, then post via Gitea API: `gitea pr-comment <pr-number> --body-file <temp-file-path>`
    - **Verify the comment was posted** — the command should return the comment ID. If it fails, retry once.
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

      ## Architecture Review (checks from `.claude/docs/architecture-checks.md`)

      | Check | Result | Detail |
      |-------|--------|--------|
      | OCP-1 Wiring Cost | pass / N files | <which files, registry suggestion> |
      | OCP-2 Growing Switch | pass / N cases | <which switch, case count> |
      | LSP-1 Interface Contract | pass / violation | <null/no-op return, caller branching> |
      | DRY-1 Parallel Types | pass / N files | <which literals duplicated> |
      | SRP-1 Side-Effect Breadth | pass / violation | <which function, which categories> |
      | ISP-1 Fat Injection | pass / violation | <which function, % deps used> |
      | Co-location | pass / violation | <what's misplaced> |
      | Consistency | pass / inconsistent | <what pattern is broken> |
      | Over-engineering | pass / concern | <what's unnecessary> |

      ## Prior Findings (omit on first review)

      | Prior ID | Original Description | Disposition |
      |----------|---------------------|-------------|
      | F1 (round 1) | <description> | verified-fixed / withdrawn / re-raised as F<N> (rebuttal: <why author's argument doesn't hold>) |

      ## File Coverage

      | File | Status | Notes |
      |------|--------|-------|
      | src/server/foo.ts | reviewed | F1, F3 |
      | src/client/bar.tsx | reviewed | no issues found |
      | pnpm-lock.yaml | skipped-generated | lockfile |

      ## Behavior Coverage

      | ID | File | Behavior | Disposition |
      |----|------|----------|-------------|
      | B1 | src/core/indexers/newznab.ts | test() precedence when both flareSolverrUrl and proxyUrl set | F2 |
      | B2 | src/server/routes/settings.ts | full-form save should not invalidate cache on unchanged network | verified-correct (`settings.test.ts:123`) |

      ## Interaction Checks

      | Interaction | Evidence | Result |
      |-------------|----------|--------|
      | FlareSolverr precedence x proxy IP reporting | `newznab.test.ts:260`, `torznab.test.ts:248` | verified-correct |
      | Full settings payload x network cache invalidation | `settings.test.ts:140` | F3 |

      ## Exhaustiveness: complete

      Reviewed all changed code files from `git diff --name-status origin/main...<head-branch>`. No changed code file was skipped.

      ## Depth Coverage: complete

      Enumerated behavior deltas and interaction intersections for all reviewed changed code files. Every entry is mapped to a finding or evidence-backed verified-correct disposition.

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

13. **Update labels on linked issue (MANDATORY — the orchestrator depends on these transitions):**

    Read the linked issue's current labels from step 3. Then update based on verdict:

    **If verdict is `approve`:**
    - Replace any `stage/*` label with `stage/approved` (keep `status/in-progress`, `yolo`, and all other labels)
    - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
    - Verify the output shows `stage/approved`
    - Then invoke `/merge <pr-number>` to squash merge, update issue labels, and clean up the branch
    - If merge fails, report the error — do not retry

    **If verdict is `needs-work`:**
    - Replace any `stage/*` label with `stage/fixes-pr` (keep `status/in-progress`, `yolo`, and all other labels)
    - Run: `gitea issue-update <id> labels "<comma-separated label names>"`
    - Verify the output shows `stage/fixes-pr`
    - **STOP.** Do not attempt to fix anything — that's the author's job via `/respond-to-pr-review`

14. **Report to main agent:** Overall verdict + outcome (merged or awaiting author response).

## Important

- If no `Refs #<id>` found in PR body, ask the user which issue to review against
- The diff can be large — focus on changed files, but you must still cover **all** changed files via the File Coverage table
- Do not confuse breadth with depth. Reviewing a file is insufficient unless all new behaviors in that file are explicitly enumerated and dispositioned.
- Be constructive — flag real issues, not style preferences. But err on the side of reporting: a dismissed suggestion costs the author 10 seconds, a missed defect costs a full review cycle.
- The `## Findings` JSON block is consumed by `/respond-to-pr-review` — ensure it is valid JSON with `severity` values of exactly `"blocking"` or `"suggestion"` (no other terms)
- An `approve` verdict means zero blocking findings. Any blocking finding → `needs-work`
- If there are no findings at all, use an empty array: `[]`
- Do not stop after the first few blocking findings. Continue until every changed file has an explicit coverage entry (`reviewed` or justified non-code skip).
- Do not stop after first blockers if behavior/intersection coverage is incomplete. Finish behavior enumeration and intersection checks before verdict.
- **Re-reviews require prior comment reading.** On any PR that already has `## Verdict:` comments, step 5b is mandatory. Skipping it produces review loops where the same finding bounces back and forth. The author has done work to address your findings — respect that by reading their response before re-reviewing.
- **Stand your ground when you're right.** If the author disputes a finding and their rationale is wrong, rebut it with specific evidence. Don't withdraw just because they pushed back — withdraw because they proved you wrong. But if they DID prove you wrong (showed the code works, demonstrated a tool produces no output, cited docs), have the intellectual honesty to drop it.
