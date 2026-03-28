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
        - type: command
          command: "node scripts/hooks/stop-gate.ts review-pr"
---

!`cat .claude/docs/testing.md`

!`cat .claude/docs/design-principles.md`

!`cat .claude/docs/architecture-checks.md`

# /review-pr <pr-number> — Review a pull request against its linked issue

Reviews a PR by checking the diff against the linked issue's acceptance criteria, the project's design principles, and code quality standards. Posts a structured review comment with machine-parseable findings.

**Review policy: high recall.** Prefer false positives over missed defects. The cost of a PR author dismissing a noisy suggestion is far lower than the cost of a defect reaching main. Do not cap the number of findings — report everything you find. Use `suggestion` liberally for anything that *might* matter; reserve `blocking` strictly for issues backed by concrete evidence (broken behavior, missing tests for new code paths, verified design violations). No speculative blockers — if you can't point to a specific line and a specific consequence, it's a suggestion.

## Guardrails

**This skill is READ-ONLY for source code.** Never stage, commit, or modify any files outside of `.claude/cl/` and `.narratorr/state/` (aliased as `.agents/cl/` and `.agents/state/` in some clones). The reviewer does not fix code — it reports findings for the author to address. If you find yourself editing source files, test files, config files, or anything under `src/`, STOP — you are doing the author's job.

## GitHub CLI

All GitHub commands use: `node scripts/gh.ts` (referred to as `gh` below).

## Steps

0. **Initialize stop-gate state:** `mkdir -p .narratorr/state/review-pr-<pr-number>/`

0b. **Ensure latest branch state:** Run `git fetch origin` to get the latest commits on all branches. If this is a re-review (you have reviewed this PR before in this session), the author has pushed fixes since your last review — you MUST re-run ALL steps from scratch against the updated branch. Do not reuse prior results from your session context.

1. **Fetch PR details:** Run `node scripts/gh.tspr view <pr-number> --json number,state,title,headRefName,baseRefName,author,headRefOid,url,labels,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\n\(.headRefName) → \(.baseRefName) | author: \(.author.login) | sha: \(.headRefOid) | \(.url)\nlabels: \([.labels[].name] | join(", "))\n\n\(.body // "")"'`. Extract:
   - Title, body, state, head branch, base branch, **author** (`author: <login>` in output), labels
   - Linked issue: parse `Refs #<id>` from PR body

2. **Self-review guard:** Run `node scripts/gh.tsapi user --jq '.login'` to get your authenticated username. Compare against the PR author from step 1.
   - If your username **matches** the PR author → **STOP**: "Cannot review your own PR. The authenticated user (`<username>`) is the PR author. Run `/review-pr <pr>` from a session authenticated as a different GitHub user (e.g., the reviewer account)."
   - Before stopping, consider: did the user actually want `/respond-to-pr-review <pr>` instead? If the PR already has review comments with findings from another user, the user likely wants the author to address those findings — suggest `/respond-to-pr-review <pr>` in your stop message.
   - If they differ → proceed (you are a different user than the author).

3. **Read linked issue:** Run `node scripts/gh.tsissue view <id> --json number,state,title,labels,milestone,body --jq '"#\(.number) [\(.state | ascii_downcase)] \(.title)\nlabels: \([.labels[].name] | join(", "))\(.milestone.title // "" | if . != "" then " | milestone: \(.)" else "" end)\n\n\(.body // "")"'`. Extract the **Acceptance Criteria** section.

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

5a. **Blast radius analysis:** Run `index_repository` (codebase-memory-mcp) to force a fresh incremental reindex (~1s), then run `detect_changes` with `scope='branch'` and `base_branch='main'` to map changed symbols to their callers with risk classification (CRITICAL/HIGH/MEDIUM/LOW by call-chain depth). Use this output to prioritize where to focus deepest review in steps 5d-5e — CRITICAL-risk callers indicate high-impact changes that warrant thorough behavior enumeration.

5b. **Read prior review history:** Run `node scripts/gh.tsapi repos/{owner}/{repo}/issues/<pr-number>/comments --paginate --jq '.[] | "--- comment \(.id) | \(.user.login) | \(.created_at) ---\n\(.body)\n"'`. Parse ALL comments containing `## Verdict:` (prior reviews) and `## Review Response` (author responses). Build a map of prior findings and their resolutions:
   - For each prior finding ID (F1, F2, etc.), note: the original finding, the author's resolution (`fixed`, `accepted`, `disputed`), and any rationale provided.
   - **This context is mandatory for re-reviews.** If this is the first review (no prior `## Verdict:` comments), skip to step 6.
   - **This does NOT reduce the scope of the review.** Steps 5-8 still run in full — you may find net-new issues that prior rounds missed. The prior history only affects how you handle findings that overlap with previously-disputed items (see dispute engagement rules below).

   **Dispute engagement rules** — these apply in step 11 when classifying findings. After completing the full review (steps 6-9), check each finding against the prior history map:
   - If a finding was previously raised and the author **fixed** it, verify the fix addresses the issue. If it does, drop the finding. If the fix is incomplete or introduces new problems, raise a NEW finding explaining what's still wrong (don't re-raise the old one verbatim).
   - If a finding overlaps with something the author previously **disputed** with rationale (code references, tool output, docs, test results), you MUST engage with their specific argument before re-raising it. You have three options:
     1. **Withdraw** — the author's rationale is correct. Drop the finding entirely.
     2. **Rebut** — the author's rationale is wrong. Raise the finding again with a NEW reason that directly addresses and refutes their argument. Explain specifically why their evidence doesn't hold. "The spec says X" is not a rebuttal if the author demonstrated X is technically impossible.
     3. **Refine** — the author's rationale is partially correct but misses something. Raise a narrower or modified finding that accounts for their point.
   - **Re-raising a finding with the same description and reason after it was disputed is NOT allowed.** If you can't produce a concrete rebuttal to the author's specific argument, withdraw the finding. Repeating yourself is not reviewing — it's a defect.
   - **Re-read before re-raising:** Before re-raising ANY finding (disputed or otherwise), re-read the current file contents to verify the concern still exists. Do not rely on cached context from a prior round — the author may have fixed it. Re-raising based on stale file contents wastes a full review round.
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
     - State transitions and side effects (including fire-and-forget triggers),
     - Input/output contract changes (request fields, response fields, optional fields),
     - Caching/invalidation behavior,
     - New mutations (`useMutation`) and their consequences,
     - New callback wiring (parent passes handler to child).
   - **Granularity rule:** Split behaviors by independently breakable consequence. Do not collapse multiple side effects into one broad entry like "mutation works" or "tests missing for hook." If a success path both toasts and invalidates cache, those are separate behaviors unless one assertion necessarily proves both. If a hook owns save, rename, and monitor mutations, enumerate each mutation's success/failure/cache-update consequences separately.
   - Create a `Behavior Coverage` table entry per behavior with:
     - `id` (B1, B2, ...),
     - `file`,
     - `behavior`,
     - `test-level`: the level where this behavior MUST have direct test coverage — one of `service` | `route` | `hook` | `component` | `page`,
     - `status`: `finding(F#)` or `verified-correct (test-file:line)`.
   - A behavior listed as `verified-correct` must cite a specific test file and line/describe block that directly exercises the behavior at the required test level. "Tests exist nearby" or "covered by higher-level test" is insufficient unless the higher-level test actually executes the exact code path.
   - **Deletion heuristic:** For each `verified-correct` entry, ask: "If this behavior's code were deleted, would the cited test fail?" If the answer is unclear, the coverage is insufficient — change status to `finding`.
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
   - **Bad behavior entries (too broad, non-falsifiable, wrong test level):**
     - "Handles settings correctly."
     - "Proxy logic works."
     - "Routes look fine."
     - `useActivity.ts`: "approveMutation works" — test-level: page — **wrong**: mutation behavior requires hook-level coverage, not just page rendering.
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

   Flag any behavior that exists in source but has no test as a **blocking** finding with category `"tests"`. The finding must name the specific untested behavior and explain what defect it could catch.
   - **Assertion contract required:** Every test-category finding must specify the **minimum assertion contract** — the specific values, predicates, or behaviors the test must verify. "Add a test for X" is not a valid finding. "Add a test that asserts `pruneOlderThan(90)` passes `lt(bookEvents.createdAt, cutoffDate)` to `.where()` — a test that only checks `db.delete` was called would not catch a comparator regression (`lte` vs `lt`)" is. The goal: the author can satisfy the finding in one pass without guessing what "sufficient" means.
   - **No umbrella findings:** Do not stop at a coarse finding like "new hook lacks enough tests" if the missing coverage can be enumerated more precisely. Convert that umbrella concern into the concrete missing behaviors (for example: rename success does not assert cache invalidation; monitor success does not assert cache invalidation; save failure does not assert error recovery). The goal is a first-round review the author can fully satisfy without guesswork.
   - **Multi-layer audit (do not peel the onion):** For each new behavior, audit test coverage at ALL layers it touches (service → route → hook → component/page) in a single pass. Do not flag only the lowest untested layer and stop — if service tests exist but route, hook, AND page tests are all missing, report all three gaps in one round. Discovering test gaps one layer per review round is the #1 source of avoidable ping-pong.

   **Mandatory sub-audits** (apply after the per-file check above):

   - **Side-effect audit:** If the PR introduces any new side effect that is NOT the primary return value of its function (fire-and-forget call, event emission, notification dispatch, import trigger, queue enqueue, query invalidation), require direct tests for: (1) success path, (2) failure path, (3) observable consequence (log entry, status change, cache update). A side effect without failure-path coverage is a blocking finding.

   - **Mutation audit:** Every newly added `useMutation` requires direct hook-level or component-level tests covering: (1) API method called with correct arguments, (2) success consequence (toast, navigation, state update), (3) failure consequence if handled, (4) query invalidation or cache update behavior. "The page renders" is not mutation coverage.

   - **Wiring audit:** If a parent component/page adds new callback props or action handlers that wire to a child, require at least one of: (a) a page/component interaction test that exercises the full user path through that wiring, or (b) evidence that the parent passes the callback through unchanged AND an existing test already exercises that exact code path end-to-end. If neither holds, flag as blocking.

   - **Completeness cross-check:** Before finalizing test findings, re-scan the Behavior Coverage table from step 5d. Every behavior with `test-level: hook` must have hook-level test evidence. Every behavior with `test-level: route` must have route-level test evidence. A test at a different level (e.g., page-level test cited for a hook-level behavior) does not count unless it demonstrably executes the same code path. This is the primary mechanism for catching the "tests exist somewhere nearby" false positive.
   - **Ping-pong check:** Before finalizing a blocking tests finding, ask: "If the author fixed exactly what I wrote and nothing else, could a nearby unmentioned behavior in the same unit still remain untested?" If yes, the finding is still too coarse. Refine it until the remaining gap is explicit, or split it into multiple findings.
   - **Neighborhood check:** When you find a defect in a function, also audit the surrounding code in the same function for related defects. Check the full input domain (edge-case inputs, query params, null fields, URLs with special characters), not just the happy path. Finding one defect but missing an adjacent one in the same function wastes a full review round.

7b. **Test quality review** — Go beyond "do tests exist" and evaluate whether they actually catch defects:
   - **Mock realism:** Does mock data actually exercise the code path? Watch for mocks that return perfect happy-path objects when the test should verify handling of missing/optional fields.
   - **Assertion specificity:** Flag lazy assertions — `toHaveBeenCalled()` without checking args, `toBeInTheDocument()` matching coincidental text. Assertions should verify the *right* thing happened, not just *something* happened. When flagging a weak assertion, specify the minimum assertion that would be sufficient (e.g., "assert `toHaveBeenCalledWith(expect.objectContaining({ retentionDays: 90 }))` — the current `toHaveBeenCalled()` would pass even if the argument were wrong").
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

   **Framework checks — always check (every PR):**
   - **ZOD-1 (Untrimmed String Validation):** Does a new or modified Zod string field use `.min(1)` without `.trim()` first? Bare `.min(1)` accepts whitespace-only input. Flag as `blocking`.
   - **TS-1 (Untyped Catch):** Does a `catch` block leave the error untyped (`catch (e)` or `catch (err)` without `: unknown`)? Flag as `suggestion`. If the untyped error is rethrown or passed to external code, flag as `blocking`.
   - **CSS-1 (Z-index Scale):** Does a new `z-` class break the established hierarchy? Scale: `z-10` sticky headers, `z-30` dropdowns, `z-40` popovers, `z-50` modals/overlays. Flag as `blocking` if a modal uses less than `z-50` or a dropdown uses `z-50`.

   **Framework checks — check when applicable:**
   - **REACT-1 (God Hook):** Does a new or modified hook return >10 values or own 4+ mutations? Flag as `suggestion`. Recommend splitting into focused hooks or grouping returns into named objects (`state`, `actions`, `counts`).
   - **REACT-2 (Inline Closures in Render Loops):** Are arrow functions created inside `.map()` that render components? Flag as `suggestion` if the child is expensive or the list is unbounded. Recommend `useCallback` + `React.memo` or stable callbacks with item ID.
   - **ERR-1 (String-based Error Routing):** Does error handling branch on `message.includes('...')` or similar string matching? Flag as `suggestion`. If the string match is the sole guard for a critical code path, flag as `blocking`. Recommend typed error classes with a `code` field.
   - **DB-1 (Late DB Update After Filesystem):** Does a new code path perform irreversible filesystem operations (rename, unlink, move) and only update the DB afterward? Flag as `blocking` — a crash between the FS op and DB write leaves inconsistent state. DB should update immediately after the first irreversible step.

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
   - TODO comments that are tracked by GitHub issues
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
    - Cross-check blocking test findings for specificity: each one should point to a concrete behavior, branch, or side effect that is still unproven. If a finding could be "satisfied" by adding some tests while leaving another enumerated behavior in the same unit uncovered, split or refine the finding before posting.

11b. **Reviewer self-critique (round 2+ only, when new findings exist on original code):**
    If this is a re-review (prior `## Verdict:` comments exist) and any new findings target code that was present in the original diff (NOT code introduced by fix commits since the last review), perform a self-critique:

    For each such finding, analyze: "This code was in the diff during my round 1 review. Could I have caught this then? What specific addition or change to the `/review-pr` prompt would have helped me identify this in the first round?"

    Write a retrospective file: `.claude/cl/reviews/reviewer-pr-<issue-id>-round-<N>.md`. Create `.claude/cl/reviews/` if it doesn't exist.

    Format:
    ```yaml
    ---
    skill: review-pr
    issue: <id>
    pr: <pr-number>
    round: <N>
    date: <YYYY-MM-DD>
    new_findings_on_original_code: [F1, F4, ...]
    ---
    ```
    Then for each finding:
    ```
    ### <finding-id>: <short description>
    **What I missed in round 1:** <the finding>
    **Why I missed it:** <was it masked by other issues? did I not look deep enough at this file? did I not trace the call chain? did I not check test coverage for this specific behavior?>
    **Prompt fix:** <specific text to add/change in `/review-pr` that would catch this class of issue in round 1>
    ```

    Skip this step if all new findings are on code introduced by fix commits (those are genuinely new issues, not round-1 misses).

11c. **Write review file and phase marker:**
    - Write the full review comment body (from the template below) to `.narratorr/state/review-pr-<pr-number>/review.md`
    - Then write the phase marker: `echo done > .narratorr/state/review-pr-<pr-number>/review-complete`
    - **Do NOT call `node scripts/gh.tspr comment` directly — the posting script is the only authorized posting mechanism.**

12. **Post review comment on PR (MANDATORY — this is a GitHub API call, not stdout):**
    - Run: `node scripts/post-review.ts <pr-number>`
    - The script reads `review.md` from the state directory, posts it as a single `node scripts/gh.tspr comment`, and writes the `posted` marker. It refuses to run if `review-complete` is missing (analysis incomplete) or `posted` already exists (double-post guard).
    - If the script outputs `ERROR:`, investigate and fix the issue before proceeding.
    - Template (written to `review.md` in step 11c):
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

      | ID | File | Behavior | Test Level | Disposition |
      |----|------|----------|------------|-------------|
      | B1 | src/core/indexers/newznab.ts | test() precedence when both flareSolverrUrl and proxyUrl set | service | F2 |
      | B2 | src/server/routes/settings.ts | full-form save should not invalidate cache on unchanged network | route | verified-correct (`settings.test.ts:123`) |
      | B3 | src/client/hooks/useActivity.ts | approveMutation calls api.approveDownload with correct ID | hook | verified-correct (`useActivity.test.ts:45`) |
      | B4 | src/client/pages/ActivityPage.tsx | approve button click triggers approveMutation | page | F5 |

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

13. **Commit and push CL files:** Retrospective files from step 10 need to be committed to main so all clones stay in sync. This MUST happen before the merge so the clone is clean for `merge.ts`'s `git pull`.
    ```bash
    git checkout main
    git pull origin main
    git add .claude/cl/
    git commit -m "CL from PR #<pr-number> review"
    node scripts/git-push.ts origin main
    ```
    If there's nothing to commit (no new CL files), skip this step.

14. **Update labels (MANDATORY — the orchestrator depends on these transitions):**

    **If verdict is `approve`:**
    - Set `stage/approved` on the **PR**: `node scripts/update-labels.ts <pr-number> --pr --replace "stage/" "stage/approved"`
    - Verify the PR output shows `stage/approved`
    - Then run `node scripts/merge.ts <pr-number>` to squash merge, update issue labels, and clean up the branch
    - If merge output starts with `REBASE:` — the branch is behind main. Attempt a clean rebase:
      1. `git checkout <head-branch> && git fetch origin main && git rebase origin/main`
      2. If the rebase succeeds (no conflicts): `node scripts/git-push.ts --force-with-lease` then re-run `node scripts/merge.ts <pr-number>`
      3. If the rebase has conflicts: `git rebase --abort && git checkout main` — fall through to the `REBASE_CONFLICT` handling below
    - If merge output starts with `REBASE_CONFLICT:` (or a `REBASE:` rebase attempt failed with conflicts above):
      1. Overwrite `.narratorr/state/review-pr-<pr-number>/review.md` with a conflict verdict:
         ```
         ## Verdict: needs-work

         ## Findings
         ```json
         [{"id":"F1","severity":"blocking","category":"rebase","description":"Branch has merge conflicts with main. Run `git fetch origin main && git rebase origin/main`, resolve all conflicts, and push.","files":[]}]
         ```
         ```
         Then run: `node scripts/post-review.ts <pr-number> --force` to post the conflict verdict (--force bypasses the posted-marker guard since the approve was already posted).
      2. Set `stage/fixes-pr` on the **PR**: `node scripts/update-labels.ts <pr-number> --pr --replace "stage/" "stage/fixes-pr"`
      3. Set `status/in-progress` on the **issue**: `node scripts/update-labels.ts <id> --replace "status/" "status/in-progress"`
      4. **STOP.** The implementer will pick this up via `/respond-to-pr-review`.
    - If merge output starts with `ERROR:` — report the error, do not retry

    **If verdict is `needs-work`:**
    - Set `stage/fixes-pr` on the **PR**: `node scripts/update-labels.ts <pr-number> --pr --replace "stage/" "stage/fixes-pr"`
    - Set `status/in-progress` on the **issue**: `node scripts/update-labels.ts <id> --replace "status/" "status/in-progress"`
    - Verify the PR shows `stage/fixes-pr` and the issue shows `status/in-progress`
    - **STOP.** Do not attempt to fix anything — that's the author's job via `/respond-to-pr-review`

15. **Clean up state:** `rm -rf .narratorr/state/review-pr-<pr-number>/`
    - The `posted` marker was already written by `post-review.ts` in step 12 or 14.

16. **Report to main agent:** Overall verdict + outcome (merged or awaiting author response).

## Important

- If no issue reference (`Refs #<id>`, `closes #<id>`, `fixes #<id>`) found in PR body, ask the user which issue to review against
- The diff can be large — focus on changed files, but you must still cover **all** changed files via the File Coverage table
- Do not confuse breadth with depth. Reviewing a file is insufficient unless all new behaviors in that file are explicitly enumerated and dispositioned.
- Be constructive — flag real issues, not style preferences. But err on the side of reporting: a dismissed suggestion costs the author 10 seconds, a missed defect costs a full review cycle.
- The `## Findings` JSON block is consumed by `/respond-to-pr-review` — ensure it is valid JSON with `severity` values of exactly `"blocking"` or `"suggestion"` (no other terms)
- An `approve` verdict means zero blocking findings. Any blocking finding → `needs-work`
- If there are no findings at all, use an empty array: `[]`
- Do not stop after the first few blocking findings. Continue until every changed file has an explicit coverage entry (`reviewed` or justified non-code skip).
- Do not stop after first blockers if behavior/intersection coverage is incomplete. Finish behavior enumeration and intersection checks before verdict.
- Broad findings create review ping-pong. Prefer several precise findings over one vague finding whenever different behaviors could be fixed independently.
- **Re-reviews require prior comment reading.** On any PR that already has `## Verdict:` comments, step 5b is mandatory. Skipping it produces review loops where the same finding bounces back and forth. The author has done work to address your findings — respect that by reading their response before re-reviewing.
- **Stand your ground when you're right.** If the author disputes a finding and their rationale is wrong, rebut it with specific evidence. Don't withdraw just because they pushed back — withdraw because they proved you wrong. But if they DID prove you wrong (showed the code works, demonstrated a tool produces no output, cited docs), have the intellectual honesty to drop it.
