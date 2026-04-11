# Workflow Log

## #487 DRY: consolidate formatDuration (4 copies) and formatChannels (2 copies) — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #495

### Metrics
- Files changed: 8 | Tests added/modified: 27 new tests in format.test.ts, 6 removed from helpers.test.ts
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean DRY refactor — spec was well-defined after 2 rounds of spec review, all component tests served as perfect regression guards, zero fix iterations needed
- Friction / issues encountered: None — the spec review process caught all contract gaps upfront (undefined handling, dual seconds-formatting modes, channels boundary)

### Token efficiency
- Highest-token actions: Explore subagent for plan (thorough codebase read of all 6 source files + tests)
- Avoidable waste: None significant — straightforward implementation
- Suggestions: For pure DRY refactors with well-reviewed specs, the plan phase could be lighter since the spec already contains all implementation detail

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced; this PR resolves the formatDuration/formatChannels DRY-2 debt

### Wish I'd Known
1. The options object pattern (`{ alwaysShowBoth, fallback }`) is cleaner than multiple named variants for formatting functions with behavioral differences — one function, explicit call sites
2. Component tests are the best regression guard for DRY refactors — 70 existing tests caught zero regressions, confirming behavior preservation
3. The spec review process (2 rounds) saved significant implementation time by resolving contract ambiguities before any code was written

## #488 Polish: ActivityPage type=button, SecuritySettings ConfirmModal, useImportPolling SSE — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #494

### Metrics
- Files changed: 6 | Tests added/modified: 13 new tests across 3 test files
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (ActivityPage test needed getEventHistory mock + text-based button query instead of role-based)
- Context compactions: 0

### Workflow experience
- What went smoothly: Three isolated changes with clear prior art. ConfirmModal migration was straightforward — existing component, 20+ usage examples.
- Friction / issues encountered: ActivityPage test button query — `getByRole('button', { name: /downloads/i })` failed because the buttons contain icon SVGs that affect accessible name computation. Solved by using `getByText('Downloads').closest('button')`.

### Token efficiency
- Highest-token actions: Reading SecuritySettings source + test files to understand full confirm panel and mutation patterns
- Avoidable waste: None — the elaborate/spec-review rounds in the previous conversation had already validated all assumptions
- Suggestions: For polish issues with multiple small fixes, the three-module TDD approach works cleanly

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. ActivityPage test file scopes `beforeEach` mocks inside the main `describe` — new top-level describes need their own mock setup (see `activitypage-tab-button-test-setup.md`)
2. ConfirmModal migration changes DOM structure enough to break text-based assertions — always grep for old inline panel text in tests (see `confirm-modal-migration-test-impact.md`)
3. Trivial issue overall — prior art (ConfirmModal, useSSEConnected) made all three fixes copy-paste-adapt

## #480 Bug: LibraryPage silently shows empty state on query error — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #493

### Metrics
- Files changed: 4 | Tests added/modified: 8
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean implementation — the DiscoverPage pattern was a clear reference. Red/green TDD cycle worked well with 6 failing tests going green in one implementation pass.
- Friction / issues encountered: Spec review required 3 rounds due to AC4 stats-failure wording contradicting the test plan (empty vs non-empty books distinction). The loading spinner test stub used `role="status"` which doesn't exist on the `LoadingSpinner` component — had to check the actual component for `data-testid="loading-spinner"`.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds of elaborate + respond-to-spec-review before implementation)
- Avoidable waste: None significant — the spec review rounds were necessary to disambiguate the AC
- Suggestions: For simple bug fixes, the spec review cycle could be lighter

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None new — existing usePagination debt already logged

### Wish I'd Known
1. The empty-library gate depends on `totalAll` from stats, not `totalBooks` from books — two separate queries with independent failure modes. Reading `useLibraryPageState` upfront would have surfaced the dual-query issue immediately.
2. `placeholderData: (prev) => prev` in TanStack Query still sets `isError: true` on failure — the stale data is kept but the error flag is reliable for branching.
3. The `LoadingSpinner` component uses `data-testid="loading-spinner"`, not `role="status"` — always check the actual component before writing test selectors.

## #481 Bug: health-check notification await blocks check cycle despite fire-and-forget comment — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #492

### Metrics
- Files changed: 2 | Tests added/modified: 3 new tests
- Quality gate runs: 2 (pass on attempt 1 after lint fix)
- Fix iterations: 1 (unused `log` destructure in test caught by lint)
- Context compactions: 0

### Workflow experience
- What went smoothly: Straightforward bug with well-established pattern — 3 existing callers of `fireAndForget` made the fix obvious
- Friction / issues encountered: None — the spec was well-validated through 2 rounds of spec review before implementation

### Token efficiency
- Highest-token actions: Explore subagent during /plan (thorough but largely redundant since /elaborate already explored the same area)
- Avoidable waste: The /plan explore could have been lighter given /elaborate already surfaced all findings
- Suggestions: For simple bugs with prior /elaborate, /plan explore could be scoped narrower

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None discovered

### Wish I'd Known
1. Deferred promise sequencing is the idiomatic way to test fire-and-forget behavior in this codebase — avoids flaky wall-clock assertions (captured in `learnings/deferred-promise-sequencing-test.md`)
2. The existing test at line 471 only covered rejection-doesn't-throw, not non-blocking behavior — the await bug was invisible to it because rejected promises still resolve through try/catch
3. No surprises — this was a textbook one-line fix with well-documented prior art

## #478 Test coverage: untested frontend branches that mask real failures — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #491

### Metrics
- Files changed: 2 | Tests added: 5
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Small, focused test-only issue — 3 contract tests + 2 integration tests. All passed on first run.
- Friction / issues encountered: Elaboration initially claimed `api-contracts.test.ts` didn't exist and proposed creating per-module test files. Cost a full spec review round-trip to correct. Also, ActivityPage mock api object was missing `cancelMergeBook` — needed to add it before tests could work.

### Token efficiency
- Highest-token actions: Elaborate + respond-to-spec-review (2 rounds before implementation could start)
- Avoidable waste: Elaboration should have run `git ls-files` to verify test file existence before claiming it didn't exist
- Suggestions: For test-gap issues, always verify existing test file layout before proposing new files

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `api-contracts.test.ts` already exists as the centralized API wrapper contract suite — always `git ls-files` before proposing new test files (see `elaborate-verify-existing-tests.md`)
2. ActivityPage mock api object must explicitly list every `api.*` method — missing methods cause "not a function" errors at runtime (see `activitypage-mock-api-cancelmerge.md`)
3. Two of five originally-scoped ACs were already complete on main — checking existing test coverage against each AC upfront halves the spec work

## #477 Test coverage: untested backend branches that mask real failures — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #490

### Metrics
- Files changed: 7 (4 deleted, 3 modified) | Tests added: 14
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 1 (readdir ENOENT test passed in isolation but failed in suite — mock leak from missing `vi.clearAllMocks()` in `beforeEach`)
- Context compactions: 0

### Workflow experience
- What went smoothly: Dead code deletion was straightforward (grep confirmed zero callers). TDD cycle for housekeeping and import-list tests was clean.
- Friction / issues encountered: book.service.test.ts `beforeEach` doesn't call `vi.clearAllMocks()`, so fs mock implementations leak between tests. Required explicit `mockReset()` before overriding. Also, `createMockDb()` doesn't include `db.run()` which is needed for the VACUUM test.

### Token efficiency
- Highest-token actions: Reading existing test files to understand mock patterns
- Avoidable waste: Could have checked `beforeEach` for `clearAllMocks` before writing the first cover-upload test
- Suggestions: When adding tests to existing suites, always check the `beforeEach` mock cleanup strategy first

### Infrastructure gaps
- Repeated workarounds: Adding `db.run` mock manually — `createMockDb()` helper should include it
- Missing tooling / config: None
- Unresolved debt: Inline housekeeping callback at `jobs/index.ts:54` lacks per-sub-task error isolation (logged in debt.md)

### Wish I'd Known
1. `book.service.test.ts` `beforeEach` doesn't call `vi.clearAllMocks()` — must `mockReset()` fs mocks explicitly (see `mock-reset-before-override.md`)
2. `executeTracked()` propagates errors — no internal catch. Tests must `.catch()` when asserting behavior after a thrown callback (see `executetracked-propagates-errors.md`)
3. `createMockDb()` omits `db.run()` — must add it manually for VACUUM tests (see `createMockDb-missing-run.md`)

## #470 ESLint lazy suppression cleanup — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #489

### Metrics
- Files changed: 12 | Tests added/modified: 6 new test files (29 tests)
- Quality gate runs: 6 (pass on attempt 6 — first 5 had lint, typecheck, unused import issues)
- Fix iterations: 5 (DownloadsTabSection max-lines, useLibraryPageState complexity, mutation prop types, unused React import, unused path.join)
- Context compactions: 0

### Workflow experience
- What went smoothly: Backend extraction (enrichment helper) was clean — 286 existing tests passed on first try after extraction. Frontend ActivityPage extraction also clean — 50 tests passed immediately.
- Friction / issues encountered: LibraryToolbar props interface mismatch after extracting useLibraryPageState (sortProps/filterProps are nested objects, not flat props). Required reading the original component to understand the API. Also, `enrichImportedBook` and `processOneImport` stayed over complexity threshold after extraction — the spec assumed extraction would fix it but `??`/`||` operators in event payloads inflate the metric.

### Token efficiency
- Highest-token actions: Multiple verify.ts runs (6 attempts) fixing lint/typecheck issues one at a time
- Avoidable waste: Should have run `pnpm typecheck` before verify.ts to catch type errors faster. The mutation prop types (`void` vs `{ success: boolean }`) could have been caught by reading useActivity.ts return types upfront.
- Suggestions: When extracting components with prop interfaces, always check the actual mutation return types from the hook — don't assume `void`.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: enrichImportedBook/processOneImport complexity (nullable coalescing inflates ESLint metric)

### Wish I'd Known
1. ESLint counts `??` and `||` as cyclomatic complexity branches — extracting "real" logic doesn't reduce the metric when nullable coalescing remains (see `eslint-complexity-nullish-coalescing.md`)
2. LibraryToolbar expects `filterProps` and `sortProps` as nested object props, not flat — reading the target component's prop interface before writing the wrapper saves a debug cycle
3. Extracting a hook from a page component relocates complexity 1:1 — pure helper functions outside the hook are needed to actually reduce the count below threshold (see `hook-extraction-complexity-relocation.md`)

## #468 Test coverage gaps from PR review batch — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #476

### Metrics
- Files changed: 2 | Tests added/modified: 5 (4 refactored, 1 added)
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Small, focused test-only issue — clear spec after 3 rounds of review, mechanical implementation
- Friction / issues encountered: Spec review required 3 rounds to get AC #3 right (invalid ASIN example, incorrect "already covered" claims). The elaborate step initially missed that 3/5 gaps were already covered, and then overcorrected by claiming NO_AUDIO_FILES was clean.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds consumed significant context before implementation started)
- Avoidable waste: The elaborate step could have read the actual test file lines more carefully to avoid 2 rounds of spec corrections
- Suggestions: For test-gap issues, always read the exact lines cited in the spec body before making claims about coverage status

### Wish I'd Known
1. `rejects.toMatchObject({ code: '...' })` is the idiomatic Vitest pattern for asserting both error type and error properties in one call — eliminates the double-invocation anti-pattern
2. The ASIN regex requires exactly `B0` + 8 alphanumeric chars — easy to get wrong when writing example values (B0EXAMPLE is only 7)
3. 3/5 of the originally-reported test gaps had already been filled by prior PRs — always verify gap claims against current main before writing specs

## #466 Cover upload polish: error registry, redundant checks, constant placement — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #475

### Metrics
- Files changed: 3 | Tests added/modified: 1 (3 new tests in error-handler.test.ts)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 4-module plan mapped directly to 4 commits. All existing tests passed without modification after each change, confirming the refactors were behavior-preserving.
- Friction / issues encountered: None — straightforward cleanup issue with well-scoped AC.

### Token efficiency
- Highest-token actions: Explore subagent for plan (read many files to understand patterns)
- Avoidable waste: Elaborate subagent had already explored the same files — plan subagent duplicated some reads
- Suggestions: For polish/cleanup issues where elaborate already ran, plan subagent could be lighter

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: MAX_COVER_SIZE duplicated across 3 files (logged in debt.md)

### Wish I'd Known
1. React `useEffect` cleanup fires on every dependency change, not just unmount — this made the URL revoke consolidation trivial (see `useeffect-url-revoke-ownership.md`)
2. Error handler tests pass unchanged after registry addition because they mock the service, not the route catch block (see `error-registry-route-catch-removal.md`)
3. The 500 response body change ("Failed to upload cover" → "Internal server error") was the only externally visible API change — caught by reviewer suggestion F2

## #465 MergeProgressIndicator: extract shared icon component + narrow outcome type — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #474

### Metrics
- Files changed: 4 | Tests added/modified: 1 (6 new tests)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (LoadingSpinner animate-spin assertion — fixed by using data-testid)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean extraction — identical icon logic in both consumers made the shared component trivial. Existing test coverage in BookDetails.test.tsx and MergeCard.test.tsx passed without modification.
- Friction / issues encountered: LoadingSpinner has `animate-spin` baked into its base class, so the initial test assertion to distinguish it from RefreshIcon by checking `not.toContain('animate-spin')` failed. Fixed by using `data-testid="loading-spinner"` instead.

### Token efficiency
- Highest-token actions: Explore subagent for plan phase (thorough but much of the info was already known from /elaborate)
- Avoidable waste: The elaborate → respond-to-spec-review → plan exploration chain explored the same files 3 times across sessions
- Suggestions: For simple refactors, the plan Explore could be lighter-weight since elaborate already validated all file paths

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `phase: string` remains untyped in MergeProgress/MergeCardState (existing debt item at .narratorr/cl/debt.md:22)

### Wish I'd Known
1. `LoadingSpinner` in `icons.tsx` hardcodes `animate-spin` as a base class — can't use CSS class absence to distinguish it from `RefreshIcon`. Use `data-testid` instead. (See `.narratorr/cl/learnings/loading-spinner-animate-spin.md`)
2. When extracting a shared component from consumers with different prop shapes, design props as the minimal intersection rather than accepting full state objects. (See `.narratorr/cl/learnings/merge-status-icon-props-narrowing.md`)
3. The `isQueued` variable in `MergeProgressIndicator` was only used by the icon chain — after extraction it became dead code. Always check for orphaned locals after extracting logic.

## #464 Event history: hasReasonContent false positive on null values + unconditional Indexer row — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #473

### Metrics
- Files changed: 4 | Tests added/modified: 8
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean red/green TDD cycle — both bugs had clear failing test cases and one-line fixes
- Friction / issues encountered: None — straightforward bug fix with well-defined spec

### Token efficiency
- Highest-token actions: Explore subagent (comprehensive but this was a simple issue)
- Avoidable waste: Explore subagent could have been skipped for a 2-file bug fix — the elaborate phase already gathered all needed context
- Suggestions: For simple bug fixes with clear file targets, skip the Explore subagent in /plan and use direct reads

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `GrabbedDetails` line 20 has dead `'—'` fallback branch in `indexerName` computation (harmless, not worth a separate fix)

### Wish I'd Known
1. `Object.keys().length` vs `Object.values().some()` is a common false-positive pattern when checking for "meaningful content" in objects with nullable values — worth a CLAUDE.md gotcha entry
2. The elaborate phase already gathered all codebase context needed — the plan's Explore subagent was redundant for this simple issue
3. All three test files were well-structured with clear patterns, making test additions trivial

## #469 SearchReleasesModal: remove redundant fields after pickGrabFields + stale docstring — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #472

### Metrics
- Files changed: 2 | Tests added/modified: 0
- Quality gate runs: 2 (pass on attempt 1 after type fix)
- Fix iterations: 1 (initial removal broke typecheck — `Partial<GrabPayload>` return type needed tightening)
- Context compactions: 0

### Workflow experience
- What went smoothly: Tiny scope, existing test suite validated the change immediately
- Friction / issues encountered: Removing the redundant overrides exposed a type-level dependency — `pickGrabFields` returned `Partial<GrabPayload>` which made required fields optional, so the "redundant" overrides were serving as type narrowing. Had to tighten the return type to `Omit<GrabPayload, 'bookId' | 'replaceExisting'>`.

### Token efficiency
- Highest-token actions: Explore subagent for plan (thorough for a 2-line change)
- Avoidable waste: Plan exploration was overkill for this cleanup issue
- Suggestions: For cleanup/chore issues with <5 lines changed, consider a lightweight plan path

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `search-pipeline.ts` at 495 lines exceeds 400-line soft limit (logged to debt.md)

### Wish I'd Known
1. The `Partial<GrabPayload>` return type on `pickGrabFields` was the root cause of the "redundant" overrides — they existed for type narrowing, not runtime behavior. Reading the function signature before planning would have surfaced this.
2. TypeScript doesn't narrow object types through property guards on function parameters — `if (!result.downloadUrl) return` narrows `result.downloadUrl` but not `result` as a whole for intersection types.
3. When a dynamic picker casts from `Record<string, unknown>`, the cast target should be as precise as possible — `Partial` is not more honest than `Omit` when both are approximate.

## #467 CODEC_REGEX lastIndex: unconditional reset before test() — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #471

### Metrics
- Files changed: 2 | Tests added/modified: 11 new tests
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Narrow scope made red/green TDD clean — 5 structural tests failed (CODEC_TEST_REGEX undefined), production code made them pass immediately
- Friction / issues encountered: Spec review took 4 rounds due to preventative hardening framing challenges — behavioral ACs are inherently vacuous when the current code already works. Needed structural ACs (exported non-global regex) to satisfy red/green requirement.

### Token efficiency
- Highest-token actions: Spec review rounds (4 rounds of elaborate/respond-to-spec-review before implementation)
- Avoidable waste: First spec attempt framed as bug fix rather than hardening, causing 2 rounds of rework
- Suggestions: For preventative hardening issues, start with structural ACs from the beginning

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. Preventative hardening specs need structural ACs that are false on main — behavioral-only ACs are vacuous by definition (see `preventative-hardening-spec-pattern.md`)
2. The `.test()` codec guard in folder-parsing is purely defensive — codec tags can't survive normalization into the narrator match. Test inputs must use non-codec narrator names to exercise the branch.
3. Exporting a regex constant for test access is a deliberate API decision that must be specified in the spec — the reviewer will catch the mismatch between test plan and module boundary
