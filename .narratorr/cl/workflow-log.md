# Workflow Log

## #482 DRY: consolidate findOrCreateAuthor/Narrator — 4 divergent copies — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #519

### Metrics
- Files changed: 5 | Tests added/modified: 1 (15 new tests)
- Quality gate runs: 2 (pass on attempt 2 — first had unused `vi` import lint error)
- Fix iterations: 1 (lint fix for unused import)
- Context compactions: 0

### Workflow experience
- What went smoothly: Mock infrastructure transparency — all 165 existing tests passed without modification after extraction. The `mockDbChain()` proxy pattern meant DB mocks work identically whether the query logic is in a private method or an imported utility.
- Friction / issues encountered: None significant. The spec review round-trip (elaborate → review-spec → respond) was necessary to resolve the null-vs-throw contract contradiction, but the implementation itself was clean.

### Token efficiency
- Highest-token actions: Explore subagent for plan (read 4 implementations + 3 test files + helpers)
- Avoidable waste: Could have skipped reading test files in detail since mocks worked transparently
- Suggestions: For pure DRY extractions of Drizzle query patterns, trust that mockDbChain will propagate and skip blast-radius test analysis

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. Drizzle mock proxies (`mockDbChain`) are fully transparent through function extraction — no test updates needed for any of the 3 blast-radius suites
2. The import-list catch scope is critical — wrapping only the author resolution + junction insert, not the whole processItem, preserves bookEvents/logging
3. The `onConflictDoNothing` vs try/catch divergence was cosmetic — both handle the same race condition, just with different APIs. Unifying to try/catch was the simpler choice since it matches the majority pattern (book.service)

## #483 DRY: unify SSE safe-emit into shared utility — 2026-04-12
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #517

### Metrics
- Files changed: 8 | Tests added/modified: 4 (safe-emit.test.ts new, import-steps.test.ts +2, monitor.test.ts +1/updated 1)
- Quality gate runs: 2 (pass on attempt 2 — first failed on test payload type mismatches)
- Fix iterations: 1 (SSEEventPayloads strict types required exact payload shapes in test fixtures)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean extraction pattern — search-pipeline.ts had the exact reference implementation. All existing test suites passed after migration with minimal changes.
- Friction / issues encountered: Test payload types are strictly enforced by the SSEEventPayloads mapped type. Used `progress` instead of `percentage` and missed required fields, causing typecheck failure. Always read the Zod schema before writing test payloads.

### Token efficiency
- Highest-token actions: Explore subagent reading all 7 call sites and their test files
- Avoidable waste: Could have read SSE payload schemas before writing test fixtures to avoid the typecheck fix iteration
- Suggestions: For future extractions, read the type definitions first, then write tests

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Coverage check script flags `import-side-effects.ts` as missing tests because its tests live in `import-steps.test.ts` (re-export barrel pattern)
- Unresolved debt: quality-gate-orchestrator.ts (501 lines) and search-pipeline.ts (~490 lines after extraction) still exceed max-lines — already tracked in debt.md

### Wish I'd Known
1. `SSEEventPayloads` mapped type enforces exact shapes per event — read the Zod schema before writing test fixtures
2. `import-side-effects.ts` functions are tested via `import-steps.test.ts` re-exports, not a co-located test file — coverage check flags a false positive
3. sed replacements on multi-line call sites don't work — use targeted edits for multi-line patterns

## #513 DRY: extract shared utils and complete getErrorMessage adoption — 2026-04-12
**Skill path:** /elaborate → /respond-to-spec-review (×2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #516

### Metrics
- Files changed: 47 | Tests added/modified: 30 (10 getErrorMessage, 8 parseWordList, 7 mimeToExt, 1 constants, 2 re-export smoke, 2 old test file updates)
- Quality gate runs: 2 (pass on attempt 2)
- Fix iterations: 1 (template literal prefixes incorrectly collapsed by subagent — 26 test failures, fixed in commit 7)
- Context compactions: 0

### Workflow experience
- What went smoothly: Extraction modules (1-4) were clean — shared files created, tests written, callers updated, all green on first try. Spec review cycle caught real alignment issues (stale inventory, path conflict) that would have caused implementation churn.
- Friction / issues encountered: Subagent bulk replacement of client error toasts collapsed template literal prefixes into getErrorMessage fallback params, which changed behavior for Error instances (lost the prefix). Required a fix commit touching all 10 client files. Root cause: instruction to subagent was ambiguous about the two replacement patterns (simple vs template-literal-with-prefix).

### Token efficiency
- Highest-token actions: Two Explore subagents during elaborate and plan phases (codebase-wide grep for 56 callsites across 47 files)
- Avoidable waste: The first bulk replacement subagent had incorrect instructions, requiring a second fix pass. Better upfront examples would have avoided this.
- Suggestions: For mechanical bulk replacements, always include explicit examples of BOTH patterns (simple and complex) in the subagent prompt. Test a sample of changes before committing the full batch.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: The coverage check in handoff step 4 doesn't handle `.ts` → `.test.tsx` extension mapping (false positive for useAddBooksToLibrary)
- Unresolved debt: Core layer has 30 remaining `instanceof Error` ternaries; cover MIME surfaces duplicated in 4 client/server locations

### Wish I'd Known
1. `getErrorMessage(error, fallback)` returns `error.message` (not fallback) when error IS an Error — so `toast.error(getErrorMessage(error, 'Prefix'))` loses the prefix. Must keep template literals for prefix+message patterns. See `getErrorMessage-template-literal-pattern.md`.
2. `src/shared/utils.ts` exists as a flat file, blocking creation of `src/shared/utils/` directory. All new shared files must be flat at `src/shared/` root. See `shared-utils-flat-file-pattern.md`.
3. Spec review went 3 rounds due to stale adoption inventory (wrong files named, wrong counts). Building the inventory from grep results upfront instead of copying from the original issue would have saved 2 rounds.

## #512 fix: SecuritySettings ConfirmModal closes on error (UX regression) — 2026-04-12
**Skill path:** /elaborate → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #515

### Metrics
- Files changed: 2 | Tests added/modified: 1
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Trivial 1-line production fix with clear prior art (ApiKeySection pattern). Red/green TDD confirmed the test caught the regression.
- Friction / issues encountered: None — the spec was precise and the fix was obvious.

### Token efficiency
- Highest-token actions: Explore subagent for plan (more thorough than needed for a 1-line fix)
- Avoidable waste: For trivial bugs with precise specs, the explore phase could be lighter
- Suggestions: Consider a "trivial fix" fast path that skips deep codebase exploration when the spec already pinpoints exact lines

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. The fix is literally removing 1 line — the `onError` callback at line 80. The explore phase confirmed what the spec already said.
2. The ApiKeySection error test (line 922-938) is the exact pattern to follow for the assertion update.
3. No surprises — this was a clean regression from #488 with a clear fix.

## #504 Auto-blacklist failed usenet downloads by guid (not just infoHash) — 2026-04-12
**Skill path:** /elaborate → /respond-to-spec-review (x4) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #511

### Metrics
- Files changed: 6 | Tests added/modified: 30
- Quality gate runs: 3 (pass on attempt 3 — first: routes/index test mock missing setBlacklistDeps, second: duplicate local inject function conflicted with import)
- Fix iterations: 2 (mock fix + duplicate function removal)
- Context compactions: 0

### Workflow experience
- What went smoothly: Modular TDD cycle worked well — each of 4 modules committed independently with red/green tests. The positive-allowlist classifier was clean and testable.
- Friction / issues encountered: 4 spec review rounds before approval — the failure classification policy for `Audio processing failed:` errors went through negative blocklist → two-level classifier → positive allowlist. The round 4 review re-raised an already-fixed finding (reviewer evaluated stale spec body), requiring a dispute.

### Token efficiency
- Highest-token actions: 4 rounds of /respond-to-spec-review consumed significant context reading/writing issue bodies and comments
- Avoidable waste: The initial spec should have started with a positive allowlist approach rather than iterating through blocklist → two-level → allowlist
- Suggestions: For error classification specs, start with the most conservative approach (positive allowlist) and expand only if proven insufficient

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `processAudioFiles()` broad catch block prevents content-level error classification (logged in debt.md)

### Wish I'd Known
1. Start error classifiers with a positive allowlist, not a negative blocklist — spec review will push you there anyway (see `content-failure-allowlist-pattern.md`)
2. When adding setter methods to services, the routes/index.test.ts mock must also include the setter — `vi.fn()` alone produces a TypeError (see `import-orchestrator-setter-wiring.md`)
3. Monitor path guid fix was already committed before this issue was claimed — the remaining work was purely the import-failure path, not the monitor path described in the original title

## #502 Extract NZB name for language detection and reject word filtering — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #510

### Metrics
- Files changed: 14 | Tests added/modified: 74+
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (operator precedence `??` vs `||` mixing)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 5-module TDD cycle. Spec was well-elaborated after 2 rounds of spec review — caller surface gap caught early.
- Friction / issues encountered: `||` and `??` cannot be mixed without parens — esbuild catches this at build time not typecheck. The `beforeEach` import was missing from retry-search.test.ts (existing file didn't need it before).

### Token efficiency
- Highest-token actions: Explore subagent for plan (reading all 7 target files + test files)
- Avoidable waste: None significant — plan phase leveraged prior elaborate/respond-to-spec-review context
- Suggestions: For issues with many wiring points (5+ callers), batch the enrichment wiring into a single commit rather than per-caller

### Infrastructure gaps
- Repeated workarounds: `search-pipeline.ts` line count (506/400) — every pipeline feature hits this
- Missing tooling / config: No shared `getSourceTitle()` helper — same `rawTitle || title` pattern duplicated 5× across files
- Unresolved debt: `filterAndRankResults` 10-param signature (debt #52), `search-pipeline.ts` over line limit (debt #28)

### Wish I'd Known
1. **`??` and `||` cannot be mixed** — esbuild rejects `(a || b ?? c)` as ambiguous. Use `||` throughout for falsy-coalescing chains. See `nullish-coalescing-vs-or-operator-precedence.md`.
2. **`enrichUsenetLanguages` had only 1 of 6 call sites wired** — the spec review caught this, but without it the auto-grab path (the actual bug) would have shipped unfixed. See `enrichment-caller-surface-gap.md`.
3. **Module-level `vi.mock()` in test files with existing tests** — adding the mock doesn't break existing tests because the mock returns `vi.fn()` (no-op), but `beforeEach` must be imported if not already present.

## #503 Add max download size quality gate — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #509

### Metrics
- Files changed: 8 | Tests added/modified: 18 (11 backend + 5 frontend + 2 fixture)
- Quality gate runs: 2 (pass on attempt 2 — first failed on max-lines)
- Fix iterations: 1 (compacted caller sites to stay within ESLint max-lines)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean additive feature following established patterns. Schema/registry/UI all had clear precedents (grabFloor, minSeeders). Test TDD cycle worked well — stubs caught the payload assertion gap early.
- Friction / issues encountered: ESLint max-lines fired at 406 non-blank lines despite file being at 495 total on main. Had to compact the new code to stay under. Pre-existing debt item but the verify script treats it as a "new violation" because the line count increased.

### Token efficiency
- Highest-token actions: Explore subagent for plan (read many caller sites). Spec review response (earlier conversation).
- Avoidable waste: The elaborate → respond-to-spec-review → implement cycle ran in the same conversation, so earlier exploration was partially repeated.
- Suggestions: For simple additive features, skip the elaborate step and go straight to implement.

### Infrastructure gaps
- Repeated workarounds: search-pipeline.ts max-lines debt means every quality gate addition requires code compaction. The positional param pattern (10 args) makes adding new filters tedious.
- Missing tooling / config: verify.ts could distinguish truly new violations from worsened pre-existing ones (e.g., file was already over 400, just grew).
- Unresolved debt: `filterAndRankResults` positional params → options object (logged to debt.md).

### Wish I'd Known
1. ESLint max-lines counts non-blank/non-comment lines, not total lines — the file was at exactly 400 code lines on main, so any net addition would trip it
2. The inline quality type on `searchWithBroadcaster`/`searchAndGrabForBook` is not derived from the schema — must be updated manually (2 separate locations)
3. `createMockSettings()` auto-inherits new fields from `DEFAULT_SETTINGS` — only `registry.test.ts` with hardcoded fixtures needed manual updates (narrow blast radius)

## #484 DRY: unify modal lifecycle pattern — 3 incompatible strategies — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #508

### Metrics
- Files changed: 12 | Tests added/modified: 9
- Quality gate runs: 2 (pass on attempt 2 — first run caught blast radius in parent page tests)
- Fix iterations: 1 (BookDetails.test.tsx and LibraryImportPage.test.tsx dialog name assertions)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD per module was efficient — each modal is independent, so red/green cycles were fast. ConfirmModal and ManualAddFormModal were already fully compliant, saving time.
- Friction / issues encountered: Replacing `aria-label` with `aria-labelledby` changes the accessible name returned by `getByRole('dialog', { name })`. Parent page tests that queried by the old aria-label text broke. Discovered during first verify run. Also, Strategy B migration test for `isOpen=false` was initially vacuous because Modal.tsx uses createPortal (container is always empty regardless of render state).

### Token efficiency
- Highest-token actions: Spec review rounds (5 rounds of /respond-to-spec-review before approval)
- Avoidable waste: Could have verified heading levels (h2 vs h3) in the first elaboration pass instead of introducing inaccurate claims that required 3 review rounds to correct
- Suggestions: When adding ARIA attributes to existing components, always grep parent test files for the old accessible name pattern before committing

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No automated a11y check in verify.ts (would catch missing ARIA attributes)
- Unresolved debt: SearchReleasesModal (391 lines) and BookMetadataModal (357 lines) approaching max-lines limit

### Wish I'd Known
1. Replacing `aria-label` with `aria-labelledby` changes the accessible name for `getByRole` queries — grep parent tests for the old aria-label text (see `aria-label-to-labelledby-blast-radius.md`)
2. Modal.tsx uses `createPortal` so `container.querySelector` and `toBeEmptyDOMElement()` give false negatives for portal-rendered content — use `screen.queryByRole` instead (see `strategy-b-isopen-vacuous-test.md`)
3. Nested Escape isolation is simpler than expected — just gate the outer `useEscapeKey`'s `isOpen` on the inner modal's state, no hook changes needed (see `nested-escape-gating-pattern.md`)

## #501 Discover page: reconcile add-book flow with search/author pages — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #507

### Metrics
- Files changed: 13 | Tests added/modified: 29
- Quality gate runs: 4 (pass on attempt 4 — lint fixes, typecheck fixes, complexity extraction)
- Fix iterations: 3 (unused FastifyBaseLogger import, null→undefined conversion, complexity extraction)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-defined after 2 rounds of review. Backend metadata forwarding was straightforward. Client-side filtering implemented cleanly with useMemo.
- Friction / issues encountered: Fastify rejects POST requests with no body when a body schema is defined — had to switch to manual Zod validation. DB row `null` fields vs service `undefined` params required mechanical conversion. Replacing `render()` with `renderWithProviders()` missed multi-line patterns in bulk replace.

### Token efficiency
- Highest-token actions: Reading existing test files and components (DiscoverPage.test.tsx 465 lines, AddBookPopover.tsx 168 lines)
- Avoidable waste: Multiple verify runs for lint/typecheck issues that could have been caught earlier
- Suggestions: Check typecheck after each commit before accumulating fixes

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No Fastify pattern for optional body schemas — manual Zod parse is the workaround
- Unresolved debt: books.ts still 450+ lines (pre-existing)

### Wish I'd Known
1. Fastify body schema validation rejects no-body POST requests — need manual Zod parsing for optional bodies (see `fastify-optional-body-schema.md`)
2. Drizzle `$inferSelect` produces `T | null` while service params use `T | undefined` — bulk `?? undefined` conversion needed, extract to helper to avoid complexity lint (see `db-null-to-service-undefined.md`)
3. Bulk `render(` → `renderWithProviders(` replacement misses multi-line calls — grep after replace to catch stragglers (see `render-to-renderWithProviders-migration.md`)

## #497 Author page: use author= param, bump to 50 results, filter reject words, sort standalone — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #506

### Metrics
- Files changed: 7 | Tests added/modified: 19 (2 audible, 10 metadata service, 7 helpers)
- Quality gate runs: 2 (pass on attempt 2 — first failed on TS2783 in test factory)
- Fix iterations: 1 (test factory `title` specified twice — destructured to fix)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 4-module TDD cycle. Each module was independent with clear boundaries. Existing `BlacklistService` pattern made settings injection straightforward.
- Friction / issues encountered: Test factory `{ title: overrides.title, ...overrides }` triggered TS2783 — had to destructure `title` out of overrides before spreading. Minor syntax error (`{ books: }` missing `[]`) caught immediately by test run.

### Token efficiency
- Highest-token actions: Explore subagent for plan phase (comprehensive but most findings already known from elaborate phase)
- Avoidable waste: Elaborate phase had already explored most of the same files — plan's explore was partially redundant
- Suggestions: When `/implement` follows `/elaborate` on the same issue, the plan explore could be lighter

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: Client `BookMetadata` interface maintained separately from server `BookMetadataSchema` (logged in debt.md)

### Wish I'd Known
1. The `audible.ts` param branching gates on `options?.title` first — `author`-only search silently falls through to `keywords=`. Reading the branching order upfront would have saved a minute of confusion.
2. Client `BookMetadata` is hand-maintained and drifts from server schema — checking both locations immediately when touching metadata fields saves a review round-trip.
3. `parseWordList` was already exported and ready to reuse from `search-pipeline.ts` — no need to write a new word parser.

## #485 DRY: extract useSettingsForm hook — 2026-04-12
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #505

### Metrics
- Files changed: 12 | Tests added/modified: 1 (16 new hook tests)
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 2 (1. ref-during-render lint + stale eslint-disable directives, 2. import path + zodResolver type + partial settings crash in SystemSettings tests)
- Context compactions: 0

### Workflow experience
- What went smoothly: Migration pattern was very mechanical — each section followed identical boilerplate. Once the hook was built and tested, migration was fast.
- Friction / issues encountered: Three separate quality gate failures: (1) React hooks lint flags ref updates during render, (2) Zod v4 type mismatch with zodResolver's expected input type, (3) SystemSettings.test.tsx mocks partial settings that crash the new generic select function.

### Token efficiency
- Highest-token actions: Reading all 10 settings sections to understand their patterns; explore subagent for codebase analysis
- Avoidable waste: Could have run typecheck earlier (before verify.ts) to catch the import path and zodResolver type issues sooner
- Suggestions: For future hook extractions, run typecheck after writing the hook but before migrating all consumers

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: BackupScheduleForm still uses raw boilerplate (excluded per spec — different lifecycle)

### Wish I'd Known
1. `react-hooks/refs` lint rule flags `ref.current = value` during render — must use `useEffect` for ref sync (see `react-ref-render-lint.md`)
2. `zodResolver` with `z.ZodType<T>` in Zod v4 causes type errors because `_input` needs to be `FieldValues` — use `z.ZodType<T, T>` (see `zodresolver-generic-type-mismatch.md`)
3. Tests that mock `api.getSettings` with partial objects will crash a generic `select(settings)` call — the old per-section `settings?.category` guard doesn't exist in the shared hook (see `settings-hook-partial-settings-guard.md`)

## #486 DRY: add client-side getErrorMessage — 2026-04-11
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #496

### Metrics
- Files changed: 24 (1 new utility, 1 new test, 22 modified) | Tests added/modified: 1 (10 test cases)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Straightforward mechanical extraction. Server utility provided exact template. Subagent handled bulk replacement across 22 files efficiently.
- Friction / issues encountered: Session interrupted between claim and plan due to context loss — had to re-claim. Spec review cycle caught stale counts (83 → 34 → 32) before implementation, saving rework.

### Token efficiency
- Highest-token actions: Subagent for mechanical replacement across 22 files
- Avoidable waste: Initial elaboration overcounted instances (34 vs actual 32), causing an extra spec review round
- Suggestions: For count-sensitive specs, run grep verification once and use that number throughout — don't estimate

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: 3 client hooks (`useBulkOperation`, `useFetchCategories`, `useLibraryBulkActions`) lack co-located test files

### Wish I'd Known
1. The actual instance count (32) differs from the issue's original claim (83) and the elaboration's count (34) — always verify with a fresh grep before committing to numbers in the spec
2. The server utility at `src/server/utils/error-message.ts` is the exact 3-line template — no adaptation needed, just copy the signature
3. Template literal contexts (`${error instanceof Error ? error.message : 'Unknown error'}`) can use the default fallback, simplifying replacements to just `${getErrorMessage(error)}`

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
