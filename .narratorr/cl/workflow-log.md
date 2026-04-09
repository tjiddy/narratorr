# Workflow Log

## #455 Book event history timeline polish — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #458

### Metrics
- Files changed: 5 | Tests added/modified: 3 (50 new assertions)
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint + typecheck)
- Fix iterations: 1 (react-refresh lint rule + TS spread type error)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-refined after 3 rounds of review — payload shapes verified, indexer lookup contract defined, blast radius documented. TDD cycle was clean.
- Friction / issues encountered: react-refresh/only-export-components lint rule forced splitting helpers from component into separate .ts file. vi.mock importOriginal generic caused TS2698 spread error.

### Token efficiency
- Highest-token actions: Explore subagent for plan (read 15+ files), spec review response rounds (3 total across elaborate + respond-to-spec-review)
- Avoidable waste: First quality gate run could have been avoided by checking lint rules for .tsx exports before committing
- Suggestions: Check react-refresh lint rule when creating .tsx files that export non-components

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None new (existing pagination clamp debt covers EventHistorySection)

### Wish I'd Known
1. `.tsx` files exporting non-component functions trigger `react-refresh/only-export-components` — split helpers into `.ts` files from the start (see `react-refresh-mixed-exports.md`)
2. `formatBytes()` uses binary units (1024), so 500MB ≠ `formatBytes(500000000)` — always read the formatter source before writing byte assertions (see `formatbytes-binary-units.md`)
3. `vi.mock()` with `importOriginal` generic type parameter causes TS2698 on spread — use untyped `await importOriginal()` with explicit casts instead (see `vi-mock-importoriginal-spread.md`)

## #450 Cover upload: touch/mobile affordance for cover action — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #457

### Metrics
- Files changed: 3 | Tests added/modified: 6
- Quality gate runs: 1 (pass on attempt 1)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Very small scope — CSS-only change with clear spec. Red/green TDD was clean (2 tests failed as expected, 4 boundary tests already covered by existing suite).
- Friction / issues encountered: Spec review required 3 rounds due to hybrid device ambiguity and Tailwind `@variant` vs `@custom-variant` naming. The `@variant` alias was verified in Tailwind dist but official docs use `@custom-variant`.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds of elaborate/respond-to-spec-review before implementation)
- Avoidable waste: The `@variant` vs `@custom-variant` issue could have been caught in the first elaboration if the spec had cross-referenced Tailwind docs
- Suggestions: For CSS-related specs, verify directive syntax against installed package before elaboration

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No automated way to test compiled CSS output (jsdom doesn't process Tailwind); class-string assertions are the proxy
- Unresolved debt: LibraryBookCard has same hover-gated pattern needing `no-hover:` treatment (logged to debt.md)

### Wish I'd Known
1. Tailwind 4 aliases `@variant` → `@custom-variant` internally, but `@custom-variant` is the documented directive — always use the documented name to avoid spec review round-trips
2. The existing codebase has 5 components using `group-hover:opacity-100` for hover-gated visibility — a broader touch affordance pass could be done in one sweep
3. Class-string assertions via `toHaveClass()` with multi-arg form are the established test pattern for CSS class verification (14+ test files use this)

## #430 MergeCard and search modal design polish — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #456

### Metrics
- Files changed: 7 | Tests added/modified: 18
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (useEventSource.test.ts needed beforeEach resetMergeStore after hook contract change)
- Context compactions: 0

### Workflow experience
- What went smoothly: Straightforward TDD cycle — spec was well-defined after 3 rounds of review, all 4 modules implemented cleanly with clear existing patterns to follow
- Friction / issues encountered: Hook contract change (null → non-null for terminal entries) caused a cascade in useEventSource.test.ts where shared module-level store leaked state between tests. Fixed by adding beforeEach(resetMergeStore). Frontend design pass caught a no-op hover (hover:border-primary/20 matching rest state).

### Token efficiency
- Highest-token actions: Reading BookDetails.test.tsx (1740 lines) — needed to find the right insertion point for new test stubs
- Avoidable waste: None — small scope, efficient execution
- Suggestions: None

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: Merge phase enum still scattered across 4 locations (existing debt entry)

### Wish I'd Known
1. Module-level stores shared across test describe blocks need `beforeEach(reset)`, not just `afterEach(cleanup)` — test ordering can leak state when a contract change makes previously-invisible entries visible
2. `hover:border-primary/20` on an element that already has `border-primary/20` at rest is a no-op — DownloadCard's `glass-card` provides a different default border, so the same hover token has different effect
3. CSS animation stacking with `forwards` fill mode works predictably — later-delayed animations override earlier ones when they share the `opacity` property

## #444 Refresh & Scan — per-book rescan of audio files and narrator from disk — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #452

### Metrics
- Files changed: 13 | Tests added/modified: 50 (across 5 test files)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (refactored service to use `bookService.update()` instead of managing own transaction — eliminated need for `db` parameter)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-groomed after 3 rounds of spec review. Existing patterns (RetagError, retag route, useBookActions mutation) made implementation predictable. TDD cycle was clean — red→green worked without surprises.
- Friction / issues encountered: Initial service design used a standalone `db.transaction()` which required threading `db` through route deps. Discovered `bookService.update()` already handles narrator+book-row atomicity, simplifying the design significantly. The refactor happened before route implementation so no wasted work.

### Token efficiency
- Highest-token actions: Elaborate + spec review response rounds (3 rounds of spec review before approval)
- Avoidable waste: None significant — the spec review rounds caught real issues (publisher field, error contract, atomicity, skipCover)
- Suggestions: For future features following existing patterns closely, a single elaborate+review cycle should suffice

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `bookService.update()` already wraps narrator sync + book row in a single transaction via `Partial<NewBook>` — no need for standalone transaction management or `db` injection into routes
2. `getPathSize()` in import-helpers.ts already does recursive all-files directory size — no need to extract `getAudioStats()` from LibraryScanService
3. The spec review process was thorough but the `publisher` field doesn't exist in the schema — always grep the schema before referencing field names in specs

## #445 Upload custom cover art — inline preview with paste support — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #451

### Metrics
- Files changed: 13 | Tests added/modified: 28
- Quality gate runs: 2 (pass on attempt 1 after lint fix, pass on attempt 2 clean)
- Fix iterations: 1 (lint: exhaustive-deps + max-lines — fixed by extracting cover-upload.ts and inlining constant)
- Context compactions: 0

### Workflow experience
- What went smoothly: Full-stack feature with clear existing patterns (cover-download.ts, backups.ts multipart, useBookActions mutations). Spec was well-elaborated with all ACs verified against codebase.
- Friction / issues encountered: book.service.ts max-lines limit hit at 468 lines — had to extract cover-upload.ts mid-implementation. Service test mock ordering for getById (3 selects per call) required careful mock chain setup.

### Token efficiency
- Highest-token actions: Explore subagent for plan (comprehensive codebase read), coverage review subagent
- Avoidable waste: Could have checked book.service.ts line count before adding the method, avoiding the extraction refactor mid-stream
- Suggestions: Pre-check max-lines on target files before adding methods

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: none
- Unresolved debt: none introduced

### Wish I'd Known
1. book.service.ts is near the 400-line limit — check line count before adding methods to large service files (learned: cover-upload-extraction-max-lines.md)
2. Multipart route tests need a separate top-level describe with custom Fastify app — can't use base createTestApp (learned: multipart-route-tests-separate-app.md)
3. BookService getById consumes 3 mock return values per call — methods calling it twice need 6 mocks in total (learned: service-test-mock-ordering-getbyid.md)

## #447 Title similarity floor rejects valid matches after swap retry — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #449

### Metrics
- Files changed: 2 | Tests added/modified: 10
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0 (clean implementation)
- Context compactions: 0

### Workflow experience
- What went smoothly: The spec had already been through elaborate + spec-review + respond-to-spec-review, so all design decisions (trace-based swap detection, swapped context for both ranking and similarity) were resolved before implementation started. Production code was ~10 lines.
- Friction / issues encountered: None — the spec was precise and the existing `searchWithSwapRetryTrace()` helper made the fix trivial.

### Token efficiency
- Highest-token actions: Explore subagent during /plan (reading match-job.service.ts and test file)
- Avoidable waste: The /plan explore duplicated some codebase reads from the earlier /elaborate phase
- Suggestions: For issues that went through /elaborate + /respond-to-spec-review in the same session, /plan exploration could be lighter

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `searchWithSwapRetryTrace()` already existed and was used in the scan-debug endpoint — the fix was a one-line import change plus a context swap conditional (see `swap-retry-trace-context-pattern.md`)
2. When swap retry fires, ALL downstream consumers of the search context need the swapped version — not just the similarity floor (see `swap-retry-affects-all-downstream-consumers.md`)
3. The existing swap retry tests (lines 1701-1785) verified swap mechanics but never checked result confidence, which is why the bug wasn't caught by existing tests

## #446 Scan debug endpoint — trace folder parsing and metadata matching pipeline — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #448

### Metrics
- Files changed: 10 | Tests added/modified: 80 (46 folder-parsing + 7 search-helpers + 27 route)
- Quality gate runs: 3 (pass on attempt 3 — lint fixes needed)
- Fix iterations: 1 (lint: route function too long + complexity + unused imports)
- Context compactions: 0

### Workflow experience
- What went smoothly: Extraction of pure functions was clean — no `this` dependencies, all callers identified upfront, re-exports maintained backward compatibility
- Friction / issues encountered: ESLint `max-lines-per-function` (150) and `complexity` (15) hit on the route factory function after adding the new endpoint. Had to extract helpers outside the factory. Also, re-exporting with `export { } from` while also importing the same symbols causes unused-import lint error.

### Token efficiency
- Highest-token actions: Spec review response rounds (2 rounds of back-and-forth before approval)
- Avoidable waste: The elaborate/spec-review cycle consumed significant context before implementation started
- Suggestions: For extraction issues, the spec should pre-verify parser contract (parts: string[] vs raw string) before review — this was the main blocker

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Route test helper `createTestApp()` doesn't register auth plugin — auth must be tested separately via `auth.plugin.test.ts` pattern
- Unresolved debt: DiscoveredBook type still in 3 places (pre-existing, #342)

### Wish I'd Known
1. `export { foo } from './module.js'` is a standalone re-export — adding `import { foo }` in the same file causes unused-import lint errors. Use only the re-export form. (See `re-export-unused-import-lint.md`)
2. Fastify route factory functions easily exceed ESLint's function line/complexity limits when endpoints have non-trivial logic. Always extract handler bodies into standalone helpers from the start. (See `route-function-line-limit.md`)
3. Creating a trace-mode variant as a separate function (`cleanNameWithTrace`) rather than a boolean flag on the original avoids return type changes that cascade to all callers. (See `trace-mode-parity-pattern.md`)

## #439 Search priority setting — Audio Quality vs Narrator Accuracy — 2026-04-09
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #443

### Metrics
- Files changed: 18 | Tests added/modified: 64
- Quality gate runs: 4 (pass on attempt 4 — 3 lint/typecheck/test iterations)
- Fix iterations: 3 (settings blast radius in service tests, e2e typecheck, ESLint max-lines + regex escape + complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD cycle worked well — red/green per module kept progress steady. Optional parameter pattern for narrator priority was clean and avoided splitting shared helpers.
- Friction / issues encountered: Settings blast radius was the main friction — adding `searchPriority` required updating hardcoded assertions in settings.service.test.ts (8 tests) and multi-entity e2e test. The `max-lines-per-function` limit on SearchSettingsSection required extracting `inputClass` and compacting JSX descriptions.

### Token efficiency
- Highest-token actions: Explore subagent for plan + self-review + coverage review (3 subagents)
- Avoidable waste: Could have grepped for all hardcoded search settings assertions upfront before starting module 2
- Suggestions: For settings schema changes, run `grep -r 'intervalMinutes.*enabled.*blacklistTtlDays' **/*.test.ts*` upfront to find all blast radius targets

### Infrastructure gaps
- Repeated workarounds: Local `inputClass` helper to stay under line limit (3rd instance of this pattern across settings sections)
- Missing tooling / config: No shared `inputClass` utility imported across settings sections
- Unresolved debt: Updated existing debt entry for `inputClass` duplication to include SearchSettingsSection

### Wish I'd Known
1. The settings blast radius is wider than `createMockSettings()` covers — `settings.service.test.ts` and `multi-entity.e2e.test.ts` use inline objects that don't auto-merge defaults
2. `react-hook-form`'s `watch()` triggers `react-hooks/incompatible-library` lint rule — use static descriptions instead of reactive descriptions
3. ESLint `max-lines-per-function` is at exactly 150 for SearchSettingsSection — any future field additions will need compensating JSX compaction

## #437 Author ASINs never backfilled — findOrCreateAuthor discards ASIN on existing authors — 2026-04-09
**Skill path:** /elaborate → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #442

### Metrics
- Files changed: 2 | Tests added/modified: 5 new tests
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Small, well-scoped bug fix with clear root cause in the spec. The elaborate step had already validated the codebase and added a test plan, making planning and implementation straightforward.
- Friction / issues encountered: Edit tool couldn't disambiguate `findOrCreateAuthor` from `findOrCreateNarrator` (identical early-return patterns) — needed larger context string for the replacement.

### Token efficiency
- Highest-token actions: Explore subagent during /plan (codebase already explored in /elaborate)
- Avoidable waste: The /plan explore could have been lighter since /elaborate already validated everything
- Suggestions: For trivial bug fixes where /elaborate was thorough, /plan exploration could be minimal

### Wish I'd Known
1. The `findOrCreateAuthor` and `findOrCreateNarrator` functions have near-identical structure — edits need unique context to disambiguate
2. The conflict-retry catch block (unique constraint race) needs the same backfill treatment as the primary path — easy to forget
3. BookHero already has conditional author link rendering — the fix is purely backend

## #438 Reject words not filtering manual search results — 2026-04-09
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #441

### Metrics
- Files changed: 1 | Tests added/modified: 9
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Once the spec was correctly scoped (test-only issue), implementation was straightforward — single test file, clear patterns to follow from search.test.ts
- Friction / issues encountered: Spec required 3 rounds of review before approval — original bug report was stale (behavior already implemented), needed to reframe as test coverage gap. Module-level vi.mock in search-stream.test.ts forced creation of separate test file.

### Token efficiency
- Highest-token actions: Spec review rounds (3 cycles of elaborate → review-spec → respond) consumed the most context
- Avoidable waste: The initial elaboration could have detected the "behavior already exists" issue earlier by reading the SSE route source before writing the spec
- Suggestions: For bug-type issues, always verify the bug actually exists on main before elaborating the spec

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: search-stream.test.ts module-level vi.mock prevents integration testing in the same file (logged to debt.md)

### Wish I'd Known
1. The reject word filtering was already wired end-to-end on the SSE path — reading `search-stream.ts:89` first would have saved 2 spec review rounds
2. Module-level `vi.mock` in Vitest cannot be selectively unmocked per describe block — separate files are the only clean option
3. For test-only issues where production code exists, tests pass immediately — the red/green TDD convention doesn't apply

## #434 Use ffprobe for audio duration instead of music-metadata — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #440

### Metrics
- Files changed: 18 | Tests added/modified: 21 new + 4 updated
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 2 (ESLint complexity in scanAudioDirectory + max-lines in quality-gate-orchestrator)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was thorough after 2 elaboration rounds; threading strategy was well-defined; existing ffprobe patterns in cover-art.ts and audio-processor.ts made implementation straightforward
- Friction / issues encountered: MatchJobService delegates to inner MatchJob class — adding settingsService to outer class wasn't enough, had to thread to inner class. Quality-gate-orchestrator.ts was already at 501/400 max-lines — any net line addition triggered a false "new violation" in verify.ts diff-based linting, requiring line compression to net-zero.

### Token efficiency
- Highest-token actions: Explore subagents for plan and self-review
- Avoidable waste: Could have checked MatchJob inner class structure before first typecheck attempt
- Suggestions: When adding constructor params to services, always grep for inner/delegate classes that need the same param

### Infrastructure gaps
- Repeated workarounds: Compressing quality-gate-orchestrator.ts to stay at net-zero lines due to pre-existing max-lines violation
- Missing tooling / config: verify.ts diff-based lint doesn't handle file-level rules (max-lines) well when the violation is pre-existing
- Unresolved debt: quality-gate-orchestrator.ts at 501 lines needs splitting (logged in debt.md)

### Wish I'd Known
1. MatchJobService has an inner `MatchJob` class — settingsService must be threaded through both constructors, not just the outer one
2. quality-gate-orchestrator.ts is already 101 lines over the max-lines lint limit — any change to this file requires net-zero line additions
3. ESLint cyclomatic complexity counts `??` operators — destructuring options (`const { a = false, b } = opts ?? {}`) is one point cheaper than separate `opts?.a ?? false` lines

## #414 ActivityPage flaky test — queue pagination timing — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #436

### Metrics
- Files changed: 2 | Tests added/modified: 5 (3 new + 2 fixed)
- Quality gate runs: 2 (pass on attempt 2 — first caught lint violation)
- Fix iterations: 1 (ESLint exhaustive-deps rejected dotted property access in useEffect deps)
- Context compactions: 0

### Workflow experience
- What went smoothly: Root cause diagnosis was accurate from /elaborate — the stale refetch race was confirmed
- Friction / issues encountered: Understanding TanStack Query's `staleTime` vs `refetchOnMount` semantics took several iterations. `refetchOnMount: false` does NOT prevent fetches when query keys change within a mounted component — only `staleTime: Infinity` prevents all background refetches. Also, the `Pagination` component returning `null` when `total <= limit` meant boundary test assertions had to check pagination disappearance, not page label content.

### Token efficiency
- Highest-token actions: Debugging why boundary tests failed despite correct cache state — traced through TanStack Query's fetch/cache lifecycle multiple times
- Avoidable waste: Could have read the Pagination component source BEFORE writing boundary test assertions, instead of discovering the `total <= limit → null` behavior after tests failed
- Suggestions: Always read the render-condition logic of components under test before writing assertions about their visibility

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Vitest `--repeat` flag doesn't exist in v4 — had to use a shell loop for reliability testing
- Unresolved debt: 3 other `usePagination` consumers use the same unstable full-object dep pattern (logged in debt.md)

### Wish I'd Known
1. TanStack Query `staleTime: Infinity` is the correct test-isolation tool for `setQueryData` tests — `refetchOnMount: false` is insufficient because query key changes within mounted components still trigger fetches (see `tanstack-query-staletime-setquerydata.md`)
2. The `Pagination` component returns `null` when `total <= limit`, making pagination labels disappear from the DOM entirely — test assertions must account for element count changes (see `pagination-component-hides-at-boundary.md`)
3. `react-hooks/exhaustive-deps` does not support dotted property access — must destructure hook return values into local variables to use individual callbacks as effect dependencies (see `eslint-exhaustive-deps-dotted-access.md`)

## #416 mam-fields.tsx ensureMinDuration flakes detection tests — extract testable constant — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #435

### Metrics
- Files changed: 4 | Tests added/modified: 4 (3 new unit tests, 1 updated overlay test)
- Quality gate runs: 2 (pass on attempt 2 — first failed due to react-refresh lint and typecheck)
- Fix iterations: 2 (react-refresh required separate file for constants; import.meta.env untyped, switched to process.env.NODE_ENV)
- Context compactions: 0

### Workflow experience
- What went smoothly: small, focused scope — constant extraction + test cleanup was clean
- Friction / issues encountered: two unexpected blockers: (1) react-refresh/only-export-components lint rule prevents non-component exports from .tsx files, (2) tsconfig lacks vite/client types so import.meta.env.MODE causes TS2339

### Token efficiency
- Highest-token actions: reading the full IndexerFields.test.tsx during plan exploration
- Avoidable waste: could have checked lint and typecheck before first commit to catch both issues in one pass
- Suggestions: for future constant extractions from component files, always use a separate .ts file from the start

### Wish I'd Known
1. The `react-refresh/only-export-components` rule means you can never export a constant from a `.tsx` file that also exports components — always plan for a separate file
2. `import.meta.env` is untyped in this project (no `vite/client` in tsconfig types) — use `process.env.NODE_ENV` instead
3. Both issues would have been caught by running `pnpm lint && pnpm typecheck` before the first commit — verify before committing saves a fix iteration

## #431 Cancel in-progress M4B merge jobs — 2026-04-08
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #433

### Metrics
- Files changed: 20 | Tests added/modified: 11
- Quality gate runs: 3 (pass on attempt 3 — lint violations then TS error then flaky test)
- Fix iterations: 2 (lint: unused vars in test; typecheck: ProcessingResult discriminated union access)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec review cycle caught real issues (phase emission timing, typed reason field, runtime phase tracking) that would have caused implementation drift. TDD cycle worked well — schema changes first, then service, then route, then frontend.
- Friction / issues encountered: Self-review caught a real bug — `verifying` phase was emitted in deprecated `mergeBook` path but not in `executeMerge` (enqueue path). Blast radius was manageable (6 test files) since the spec called it out. The `toHaveBeenCalledWith` strict arg count caught the new `undefined` signal parameter.

### Token efficiency
- Highest-token actions: Explore subagent for plan (full merge service + audio processor + MergeCard + BookDetails reads), self-review subagent
- Avoidable waste: The first cancel-from-queue test was overengineered and had to be removed (unused variables). Should have started simpler.
- Suggestions: For cancel/abort patterns, start with the simplest cancel case (not-found) and build up

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: Merge phase enum in 4 locations (DRY-1), now logged in debt.md

### Wish I'd Known
1. The `verifying` phase was only emitted in the deprecated `mergeBook` path, not in `executeMerge`. Self-review caught this — always check ALL code paths when adding phase-dependent logic. (See learnings/verifying-phase-emission-gap.md)
2. Vitest `toHaveBeenCalledWith` is strict about arg count — adding an optional trailing `undefined` parameter breaks existing assertions. (See learnings/abort-signal-threading-depth.md)
3. The `MergeCardState.phase` is `string` (not `MergePhase`) — client-side phases like `'starting'`, `'cancelled'` don't exist in the schema but are valid UI states. CANCELLABLE_PHASES must include both schema and UI phases.

## #418 Browser caches stale cover images after book re-import — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #432

### Metrics
- Files changed: 4 source + 4 test | Tests added/modified: 19 new tests
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was thorough from elaboration — all file paths, line numbers, and component names were verified. Red/green TDD cycle was clean with no surprises.
- Friction / issues encountered: None — small, well-scoped bug fix with clear AC.

### Token efficiency
- Highest-token actions: Elaborate subagent (full codebase exploration for cover render sites)
- Avoidable waste: None — 4-module implementation was appropriately sized
- Suggestions: For pure frontend URL-manipulation fixes, the coverage subagent can be safely skipped (small diff threshold)

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None discovered

### Wish I'd Known
1. Cover render sites split cleanly into two categories (local vs external) based on source type (`BookWithAuthor` vs `BookMetadata`) — knowing this upfront would have made the blast-radius check instant
2. The `resolveCoverUrl` helper can delegate entirely to `resolveUrl` for URL_BASE handling — no need to duplicate any logic
3. `afterEach` import was missing from BookDetails.test.tsx — always check existing vitest imports before adding spy-based tests

## #421 Highlight currently installed release in search results — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #429

### Metrics
- Files changed: 4 | Tests added/modified: 15 (12 ReleaseCard + 3 SearchReleasesModal)
- Quality gate runs: 2 (pass on attempt 1 both times — once in implement, once in handoff)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-groomed (elaboration + spec review already done), types already existed on both sides, existing badge pattern made implementation straightforward
- Friction / issues encountered: None — the elaborate/spec-review cycle front-loaded all the hard questions (infoHash pipeline analysis, indicator contract precision)

### Token efficiency
- Highest-token actions: Elaborate and respond-to-spec-review in prior conversation consumed the most context exploring the infoHash grab pipeline
- Avoidable waste: None — the 14-line source diff was appropriately small for this feature
- Suggestions: For pure-display features with no backend changes, the coverage subagent can be skipped (small diff exemption worked well here)

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available — design polish skipped
- Unresolved debt: ReleaseCard complexity suppression at limit (pre-existing, logged in learnings)

### Wish I'd Known
1. The elaborate/spec-review cycle already resolved the hardest question (infoHash pipeline gap) — implementation was straightforward because the spec was precise
2. ReleaseCard's badge row pattern is highly uniform — new badges are ~6 lines of JSX following the exact same structure
3. `createMockBook()` factory doesn't include `lastGrabGuid`/`lastGrabInfoHash` in defaults (they're `undefined`), which is fine since the props are optional — no factory update needed

## #422 Show M4B merge job progress in activity queue — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #428

### Metrics
- Files changed: 11 | Tests added/modified: 97
- Quality gate runs: 2 (pass on attempt 2 — first run caught test asserting duplicate text after adding phase labels)
- Fix iterations: 2 (lint complexity + self-review caught missing complete/failed phase labels)
- Context compactions: 0

### Workflow experience
- What went smoothly: The SearchCard/useSearchProgress pattern was directly reusable — store shape, dismiss timers, ActivityPage integration, and test patterns all transferred cleanly. The spec review rounds identified every real gap (per-book vs list store, bookTitle preservation, terminal state retention, BookDetails backward compat).
- Friction / issues encountered: useSyncExternalStore requires cached snapshots — building per-book derived objects inline in getSnapshot caused infinite re-render loops. Fixed by adding a perBookCache Map rebuilt on notify().

### Token efficiency
- Highest-token actions: Explore subagent for plan (read 14 files), self-review subagent, coverage review subagent
- Avoidable waste: None significant — the 3 spec review rounds were done before /implement started
- Suggestions: The dual-accessor pattern (list + per-book from same store) could be documented as a reusable pattern for future similar features

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available — design polish skipped
- Unresolved debt: ActivityPage complexity at 17 (eslint-disable suppressed) — needs sub-component extraction

### Wish I'd Known
1. `useSyncExternalStore` snapshot functions must return cached values — new objects per call cause infinite loops. See `learnings/usesyncexternalstore-per-book-cache.md`.
2. When adding terminal phase values to a formatter, add explicit cases immediately — the `default` case silently masks missing terminal labels. See `learnings/terminal-phase-labels-in-formatters.md`.
3. The existing `useSearchProgress` pattern is a nearly 1:1 template for new ephemeral activity card types — module-level Map + cachedSnapshot + scheduleDismiss + useSyncExternalStore. Future similar features can copy this pattern directly.

## #426 Improve folder parsing for torrent naming conventions — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #427

### Metrics
- Files changed: 10 | Tests added/modified: 60
- Quality gate runs: 2 (pass on attempt 2 — first attempt had lint complexity violation and unused var)
- Fix iterations: 1 (extracted `findMergeableDiscChildren()` to reduce cyclomatic complexity from 19 to under 15)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-groomed through 3 rounds of review, making implementation straightforward. Test stubs from /plan mapped cleanly to TDD cycles.
- Friction / issues encountered: Test stubs appended to end of 3500-line test file landed in wrong describe scope (`scanDirectory` instead of `LibraryScanService`), causing `ReferenceError` for mock fixtures. Had to relocate them to the correct scope.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration during /plan phase
- Avoidable waste: Reading large test files to find correct insertion point — could have grepped for the describe block first
- Suggestions: For large test files, grep for the target describe block before appending stubs

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `CODEC_REGEX` has the global flag — `.test()` advances `lastIndex` and must be reset manually to avoid cross-call state pollution
2. In `cleanName()`, stripping order matters critically: series markers before dedup, empty brackets before narrator parens, years/codecs before narrator check
3. When appending test stubs to large files, verify the nesting scope by checking which `describe()` block owns the closing `});` — wrong scope = missing fixtures

## #424 M4B merge fails on MP3s with embedded cover art — muxer queue overflow — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #425

### Metrics
- Files changed: 3 | Tests added/modified: 21
- Quality gate runs: 2 (pass on attempt 2 — first had complexity+line-count lint violations, fixed by extracting cover-art.ts; typecheck error on MockChildProcess.kill fixed)
- Fix iterations: 1 (extracted cover art helpers to separate file to meet max-lines and complexity limits)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean TDD cycle — 3 modules implemented sequentially with clear red/green phases. Self-contained changes in audio-processor.ts meant no caller modifications needed.
- Friction / issues encountered: ESLint max-lines (400) and complexity (15) limits forced extraction of cover-art.ts mid-implementation. The extraction itself was straightforward but required passing `spawnFfmpeg` as a function parameter since it's private to audio-processor.ts.

### Token efficiency
- Highest-token actions: Spec review cycle (3 rounds of elaborate → review-spec → respond) consumed significant context before implementation began
- Avoidable waste: None — the spec review rounds caught real design issues (missing hasCoverArt source, shared caller contract, configurable vs fixed timeout)
- Suggestions: For future scope/core issues with ffmpeg, the spec should reference the exact ffmpeg arg arrays being modified to avoid ambiguity

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` works cleanly with EventEmitter-based spawn mocks — no need for complex timer workarounds (ref: `spawn-stall-timeout-fake-timers.md`)
2. ESLint max-lines is 400 — should plan file splits upfront when adding 100+ lines of new logic to an already-large file
3. The `withCoverArtPipeline` wrapper pattern (processFn callback + spawnFfmpeg injection) cleanly separates cover art lifecycle from encode logic without changing caller signatures (ref: `cover-art-pipeline-extraction.md`)

## #415 Surface match confidence reason on Review badge — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #423

### Metrics
- Files changed: 11 | Tests added/modified: 26
- Quality gate runs: 2 (pass on attempt 2 — first failed on complexity lint)
- Fix iterations: 1 (ESLint complexity exceeded 15 in matchSingleBook; refactored resolveConfidenceFromDuration to always return result instead of null)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 4-module TDD flow (backend → client type → badge → hooks). All existing tests remained green throughout.
- Friction / issues encountered: (1) Appended hook tests to wrong describe block in useLibraryImport.test.ts — caused 5s timeouts because mocks weren't initialized. (2) JS toFixed rounding gave "37.1" not "37.2" for the spec's example.

### Token efficiency
- Highest-token actions: Codebase exploration subagent (read many test files); coverage review subagent
- Avoidable waste: Read too many test patterns before writing stubs — could have started earlier since patterns are consistent
- Suggestions: For additive optional fields, test blast radius is minimal — skip exhaustive fixture audit when field is optional

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available
- Unresolved debt: DRY-2 confidence upgrade logic duplication (pre-existing, #335)

### Wish I'd Known
1. `toFixed(1)` rounds 37.15 to "37.1" not "37.2" in JavaScript — always verify decimal formatting in Node REPL (see learnings/js-tofixed-rounding-gotcha.md)
2. useLibraryImport.test.ts has multiple top-level describe blocks with isolated beforeEach — appending to the wrong block causes silent timeout failures (see learnings/test-describe-nesting-scope.md)
3. Returning null from helper functions inflates caller complexity — always return a structured result to keep ESLint happy (see learnings/resolve-confidence-return-type-refactor.md)

## #410 ABB adapter missing guid — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #420

### Metrics
- Files changed: 3 | Tests added/modified: 3
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Minimal change (1 line of production code), clear reference pattern from MAM (#348), spec review caught root-cause framing and test plan alignment issues early
- Friction / issues encountered: Spec review required 2 rounds — initial framing said "cannot be blacklisted" when ABB already works via infoHash. Lesson: verify the claimed bug path before writing the spec.

### Token efficiency
- Highest-token actions: Spec review rounds (elaborate + respond-to-spec-review consumed most context before implementation)
- Avoidable waste: The elaborate step could have caught the framing issue upfront if it had verified the blacklist flows more carefully
- Suggestions: For adapter parity issues, always verify the existing flow works before claiming it's broken

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. ABB already blacklists fine via infoHash — the spec's "cannot be blacklisted" claim was wrong. Always trace the full data path before writing the bug description.
2. ABB drops results without downloadUrl, which requires infoHash — so guid:undefined is never observable on returned results. Test plans must match the adapter's actual contract.
3. ABB has no native torrent ID unlike MAM — guid must be a copy of infoHash, not a separate identifier.

## #411 Blacklist isBlacklisted() misses guid-only entries (usenet re-grab) — 2026-04-08
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #417

### Metrics
- Files changed: 2 (1 source, 1 test) | Tests added/modified: 15 (replaced 2)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0 (clean first pass)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-elaborated through /elaborate and /respond-to-spec-review before /implement. The delegation pattern from getBlacklistedHashes() provided a clear template. Red/green TDD was straightforward — 8 tests failed, implementation made them pass.
- Friction / issues encountered: None — small, well-scoped bug fix with clear spec.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration (thorough but necessary for plan)
- Avoidable waste: None significant
- Suggestions: For trivial bug fixes with well-elaborated specs, the exploration phase could be lighter

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: isBlacklisted() has zero production callers — it exists for future use but is currently dead code

### Wish I'd Known
1. getBlacklistedHashes() already demonstrates the exact delegation pattern needed — could have gone straight to implementation with minimal exploration
2. The debt.md entry from #248 was outdated (referenced "quality gate pre-check" callers that don't exist) — debt entries should be verified before trusting
3. Mock in rss.test.ts is `vi.fn()` with no type constraints, so signature changes are automatically compatible — no blast radius update needed

## #405 DRY cleanup — extract shared cover regex, audio collector, grab payload builder — 2026-04-07
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #408

### Metrics
- Files changed: 21 | Tests added/modified: 6 (3 new test files, 3 existing test files updated)
- Quality gate runs: 3 (pass on attempt 3 — lint fix, type fix, then build fix)
- Fix iterations: 3 (unused import lint, type error on .mock property, barrel export breaking Vite client build)
- Context compactions: 0

### Workflow experience
- What went smoothly: The three extractions were mechanical and straightforward. Red/green TDD caught interface mismatches early. Existing test suites provided confidence that caller behavior was preserved.
- Friction / issues encountered: (1) Barrel-exporting `collect-audio-files.ts` broke the Vite client build because it imports `node:fs/promises` — `src/core/utils/` is shared between client and server, so Node.js imports in barrel exports are forbidden. (2) Tagging service test mocks returned plain string arrays from `readdir`, but the extracted helper calls `readdir(dir, { withFileTypes: true })` — required a smart mock that detects the call pattern. (3) Existing tests asserting `indexerId: undefined` broke because the extracted helper omits undefined fields entirely.

### Token efficiency
- Highest-token actions: The Explore subagent for plan phase read all 4 implementations fully; self-review and coverage review subagents re-read the diffs
- Avoidable waste: Could have anticipated the barrel export issue by checking if `src/core/utils/index.ts` is imported by client code before adding to it
- Suggestions: Before barrel-exporting any file in `src/core/`, check if the file imports Node.js built-ins — if so, use direct import path only

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No Vite build check in typecheck — the barrel export issue only surfaced during `pnpm build`, not `pnpm typecheck`. A stricter import analysis tool could catch this earlier.
- Unresolved debt: 3 resolved debt items (cover regex, collectAudioFiles, buildGrabPayload) marked as resolved in debt.md

### Wish I'd Known
1. Files in `src/core/utils/` that import `node:fs/promises` cannot be barrel-exported — Vite bundles the barrel for client and Node.js built-ins fail Rollup externalization (see learning: core-utils-barrel-node-fs.md)
2. When extracting a shared helper that calls `readdir` with `{ withFileTypes: true }`, existing test mocks that return plain string arrays need updating to handle both call shapes (see learning: readdir-withfiletypes-mock-shape.md)
3. When the extracted helper omits undefined fields instead of setting them to undefined, existing `objectContaining({ field: undefined })` assertions break — use `not.toHaveProperty()` instead (see learning: undefined-field-omission-in-extracted-helpers.md)

## #406 Scheduled search can re-grab blacklisted releases — 2026-04-07
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #407

### Metrics
- Files changed: 11 | Tests added/modified: 15 new + ~50 signature updates
- Quality gate runs: 2 (pass on attempt 2 — first failed on unused eslint-disable directive)
- Fix iterations: 1 (eslint-disable `max-lines-per-function` became unused after extracting inline pattern from rss.ts)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was thoroughly reviewed (3 rounds) before implementation — caller wiring surface was fully enumerated, making implementation mechanical. Existing inline patterns were nearly identical, making extraction trivial.
- Friction / issues encountered: None significant. The blast radius of changing `searchAndGrabForBook` signature was large (~50 test call sites) but predictable from the spec.

### Token efficiency
- Highest-token actions: Explore subagent for plan phase (read all wiring files); blast radius updates in test files
- Avoidable waste: Could have combined Module 2 (wiring) and Module 3 (filtering) from the start since they're tightly coupled
- Suggestions: For parameter-threading changes, estimate test file blast radius upfront and batch all signature updates in one pass

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `startSearchJob()` is dead code (zero callers) — updated for compilation but should be removed

### Wish I'd Known
1. Inserting a required param before optional params in a shared function creates a blast radius across every test file in the call chain — grep early to estimate scope (see `blacklist-filter-parameter-ordering.md`)
2. Extracting inline code from a function can make `eslint-disable` directives unused, causing lint failures — check after reducing function size (see `eslint-disable-line-count-sensitivity.md`)
3. The 3 existing inline blacklist patterns were byte-for-byte identical (only variable names differed) — extraction was trivial with no behavioral edge cases

## #394 Indexer priority as search result scoring tiebreaker — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #404

### Metrics
- Files changed: 4 | Tests added/modified: 15
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 3-module TDD cycle. All tests red→green in one pass. Spec review caught the priority direction issue early, saving implementation rework.
- Friction / issues encountered: The initial spec had inverted priority semantics (higher = better) vs existing product convention (lower = better). Caught during /elaborate spec review — required /respond-to-spec-review cycle before implementation.

### Token efficiency
- Highest-token actions: Explore subagents for codebase analysis and self-review
- Avoidable waste: None — the issue was tightly scoped and the plan was accurate
- Suggestions: For simple additive features like this, the explore subagent could be lighter-weight

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: SearchResult parallel type (core + client) — pre-existing DRY-1 debt, added one more field to keep in sync

### Wish I'd Known
1. Priority field semantics are "lower = more preferred" everywhere — the initial spec assumed the opposite, which would have caused split semantics (see `infinity-vs-zero-missing-tiebreaker.md`)
2. canonicalCompare uses mixed sort directions — `b - a` for descending tiers, `a - b` for ascending — choose based on field semantics (see `canonicalcompare-ascending-vs-descending.md`)
3. The three indexerService mapping sites (pollRss, searchAll, searchAllStreaming) use an identical spread pattern — adding a field is a simple mechanical change at all 3 sites

## #396 Wrong Release: preserve cover art + fix silent re-search failure — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #403

### Metrics
- Files changed: 8 | Tests added/modified: 29
- Quality gate runs: 2 (pass on attempt 2 — first had pre-existing flaky IndexerFields test)
- Fix iterations: 0 (clean implementation)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 4-module TDD cycle. Cover cache approach was simple and avoided all path-consumer conflicts. Override retry restructure was a targeted 10-line change.
- Friction / issues encountered: Spec review required 3 rounds — initial approach (targeted audio deletion) conflicted with path-based consumers, second approach (path preservation) had even wider blast radius. Final cover-cache approach was identified in round 3.

### Token efficiency
- Highest-token actions: Elaborate + 2 respond-to-spec-review rounds consumed significant context exploring codebase for path-based consumer conflicts
- Avoidable waste: Could have identified the path-consumer conflict during elaboration by checking quality-gate and revertBookStatus callers upfront
- Suggestions: When a spec proposes changing field nulling behavior, always grep for all consumers of that field before committing to the approach

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: COVER_FILE_REGEX duplicated in 3 files (cover-cache.ts, cover-download.ts, tagging.service.ts)

### Wish I'd Known
1. `book.path !== null` is used as an "has imported audio" proxy by 5+ consumers (quality gate, revertBookStatus, monitor, download orchestrator, quality helpers) — preserving path for cover serving was a non-starter
2. `overrideRetry: true` in `blacklistAndRetrySearch` didn't actually bypass the settings lookup — it only bypassed the boolean check AFTER the lookup succeeded. The settings `.catch()` swallowed the override
3. A cover cache at `{configPath}/covers/{bookId}/` is the simplest approach that avoids all path-consumer conflicts — no schema changes, no consumer changes, just copy-out + endpoint fallback

## #397 Multi-disc imports fail with duplicate track number collision — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review (x3) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #402

### Metrics
- Files changed: 5 | Tests added/modified: 18 new + 3 updated
- Quality gate runs: 2 (pass on attempt 1 for final, 1 initial fail for complexity)
- Fix iterations: 2 (complexity limit → extracted helpers; self-review caught collision bug)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was very well-defined after 3 rounds of spec review. The Implementation Contract section made coding straightforward — exact file:line references, exact changes needed.
- Friction / issues encountered: Existing tests used `Disc 1`/`Disc 2` as generic subfolder names, which broke when disc detection was added. Had to update 3 existing tests. The readdir mock double-call trap was the trickiest part — pre-scanning root entries before recursive collection means the root readdir is consumed twice if not careful.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds with elaborate + respond cycles consumed significant context before implementation started)
- Avoidable waste: None significant — the spec review rounds were necessary to catch real contract gaps
- Suggestions: None

### Infrastructure gaps
- Repeated workarounds: `collectAudioFiles()` is defined privately in 4+ modules — should be a shared utility
- Missing tooling / config: None
- Unresolved debt: `collectAudioFiles()` duplication logged in debt.md

### Wish I'd Known
1. Existing tests used disc-pattern folder names (`Disc 1`, `Disc 2`) as generic test fixtures — adding disc detection broke them. Always grep test files for folder names matching the new pattern before implementing.
2. Adding a pre-scan step before a recursive function causes double-readdir in mocked tests — reuse the initial readdir result instead of calling the recursive function on the root.
3. When mixing generated sequential filenames with original non-disc filenames, collision detection is essential — self-review caught a silent data-loss bug where `Extras/1.mp3` would collide with sequential `1.mp3`.

## #398 NYT import list stores titles in ALL CAPS — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #401

### Metrics
- Files changed: 2 | Tests added/modified: 25 new + 20 existing updated
- Quality gate runs: 3 (pass on attempt 3 — first two failed on lint: max-lines-per-function, then complexity)
- Fix iterations: 2 (extracted helpers to reduce function length and cyclomatic complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-defined after 2 rounds of spec review. Single-file production change made TDD cycle fast. Existing test patterns were clear and easy to follow.
- Friction / issues encountered: ESLint complexity limit (15) was tight for the expanded conditional fill logic. First extraction hit max-lines-per-function, second hit complexity because optional chaining (`?.`) counts as branches. Required 2 refactoring iterations.

### Token efficiency
- Highest-token actions: Spec review rounds (3 comments with full review JSON), Explore subagents for self-review and coverage check
- Avoidable waste: The `replace_all` approach for updating existing test mocks was efficient — avoided reading/editing 20 individual mock sites
- Suggestions: For enrichment-style changes that expand a select query, pre-identify all mock sites before making the production change

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. ESLint counts optional chaining (`?.`) as complexity branches — a function with 7 conditionals and 3 `?.` usages already hits 18/15. Extract helpers proactively when adding conditional fill logic.
2. Expanding a `db.select()` shape breaks ALL test mocks that return that shape — use `replace_all` early to batch-fix them rather than discovering failures one by one.
3. The enrichment job already has a `complexity` eslint-disable comment on `runEnrichment()` — but extracted helpers don't inherit it, so they need to independently stay under the limit.

## #395 Detect Usenet release language from NZB newsgroup metadata — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #400

### Metrics
- Files changed: 4 source + 1 test | Tests added/modified: 52
- Quality gate runs: 2 (pass on attempt 1 both times — once during implement, once during handoff)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean implementation — the spec was thorough after 3 rounds of review, all utilities existed (Semaphore, fetchWithTimeout, normalizeLanguage), single insertion point in postProcessSearchResults made wiring trivial
- Friction / issues encountered: None significant — the spec review process caught all alignment issues upfront (scandinavian mapping, caller surface ambiguity, language pill claim)

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds with elaborate + 2 respond-to-spec-review)
- Avoidable waste: The elaborate→review→respond cycle was thorough but the initial spec was missing scope boundaries and test plan, which required 3 review rounds
- Suggestions: Future specs for cross-cutting features should define scope boundaries upfront (which callers are in/out of scope)

### Wish I'd Known
1. `postProcessSearchResults()` had no logger parameter — needed to thread `request.log` from both search routes (see `postprocess-logger-threading.md`)
2. NZB `<group>` tags are simple enough for regex — no need to import cheerio for this (see `nzb-regex-parsing-over-cheerio.md`)
3. The spec review process was highly effective at catching the `scandinavian` non-canonical language and the caller surface ambiguity before any code was written — trust the process

## #392 Activity page search progress cards with per-indexer breakdown — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #393

### Metrics
- Files changed: 17 | Tests added/modified: ~100 new test assertions across 8 files
- Quality gate runs: 3 (pass on attempt 3 — lint fixes for complexity/unused vars/import paths)
- Fix iterations: 2 (1. lint complexity in handleSearchEvent + search-pipeline, 2. missing eventBroadcaster wiring in routes/index.ts)
- Context compactions: 0

### Workflow experience
- What went smoothly: Backend schema → emission → wiring → client store → component pipeline was clean. useMergeProgress.ts provided an excellent template for the store.
- Friction / issues encountered: (1) useSyncExternalStore infinite loop when getSnapshot returns new array reference on every call. (2) routes/index.ts didn't pass eventBroadcaster to BookRouteDeps — proxy-based test mocks masked this by auto-creating the property. Coverage review subagent caught it. (3) Switching from searchAll to searchAllStreaming required updating ~10 existing tests in books.test.ts that mocked searchAll.

### Token efficiency
- Highest-token actions: Coverage review subagent, exploring codebase for wiring points
- Avoidable waste: Could have caught the routes/index.ts wiring gap during Module 3 (caller wiring) by grepping for the actual wiring site
- Suggestions: When adding optional deps to route interfaces, immediately grep for the wiring call in routes/index.ts

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Proxy-based createMockServices auto-creates all properties, masking missing wiring. Consider a type-safe mock factory that requires explicit property setup.
- Unresolved debt: None new — existing debt items in search-pipeline (blacklist filtering) acknowledged but out of scope

### Wish I'd Known
1. **useSyncExternalStore requires cached snapshots** — `[...map.values()]` in getSnapshot creates infinite loops. Cache at module level and update in notify(). See `usesyncexternalstore-snapshot-caching.md`.
2. **routes/index.ts wiring is the real deployment surface** — Adding a dep to a route interface means nothing if the wiring in routes/index.ts doesn't pass it. Proxy mocks hide this. See `route-deps-wiring-gap.md`.
3. **searchAll vs searchAllStreaming path split** — When broadcaster is present, the entire code path changes. Every test that mocked searchAll needs updating when a caller gets broadcaster wired. See `streaming-search-path-split.md`.

## #386 Unified language settings + Search settings page reorganization — 2026-04-07
**Skill path:** /elaborate → /respond-to-spec-review (x3) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #391

### Metrics
- Files changed: 33 | Tests added/modified: ~46 new + ~20 updated
- Quality gate runs: 3 (pass on attempt 3 — first had lint, second had type errors)
- Fix iterations: 3 (lint violations from unused MAM imports, TypeScript type mismatch form→API, residual empty-string test args)
- Context compactions: 0

### Workflow experience
- What went smoothly: Schema changes propagated cleanly via registry pattern. Migration followed existing `bootstrapProcessingDefaults` pattern. Per-search options approach avoided adapter cache invalidation complexity entirely.
- Friction / issues encountered: Spec review took 4 rounds (initial + 3 respond cycles) before approve. Main issues: Audible/Audnexus scope confusion, canonical language artifact underspecification, quality field migration scope. Implementation itself was straightforward once spec was approved.

### Token efficiency
- Highest-token actions: Explore subagents for spec review and planning (3 rounds of elaboration + plan exploration)
- Avoidable waste: Could have gotten spec right in fewer rounds by checking metadata vs indexer pipeline distinction earlier
- Suggestions: When spec mentions "client-side filtering" for both indexers and metadata providers, verify they share a pipeline before assuming

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available as external plugin
- Unresolved debt: searchAll/searchAllStreaming duplicate language injection logic (DRY-2, minor)

### Wish I'd Known
1. `z.enum()` requires `as const` tuple — `readonly string[]` is not compatible. This caused a spec review round and a TypeScript fix iteration.
2. Metadata search (`MetadataService.search()` → `BookMetadata[]`) is a completely separate pipeline from indexer search (`filterAndRankResults` → `SearchResult[]`). The original spec conflated them — catching this early would have saved 2 spec review rounds.
3. `useWatch()` should be used instead of `watch()` from `useForm()` for React Compiler compatibility — the compiler lint rule catches it but only at lint time, not during development.

## #389 Settings page restructure — new Search page — 2026-04-06
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #390

### Metrics
- Files changed: 18 | Tests added/modified: 9 test files (~50 tests)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (protocol preference dropdown option order in test)
- Context compactions: 0

### Workflow experience
- What went smoothly: Registry-driven architecture made wiring trivial (1 file change for route + sidebar). Red/green TDD cycle per module was efficient — each card component built and tested independently.
- Friction / issues encountered: Spec had wrong file names (MetadataSettingsSection.tsx vs MetadataSettingsForm.tsx) and wrong wiring targets (Layout.tsx vs registry.ts). Two rounds of spec review were needed to fix these. The elaborate/respond-to-spec-review cycle added overhead but caught real issues before implementation.

### Token efficiency
- Highest-token actions: Explore subagent for plan codebase exploration (read many settings files)
- Avoidable waste: Spec corrections could have been caught during initial `/elaborate` if the file verification had been more thorough
- Suggestions: Always grep for actual file names before writing spec AC items

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available — design pass skipped
- Unresolved debt: None introduced

### Wish I'd Known
1. Settings routes and sidebar are entirely registry-driven via `settingsPageRegistry` — no need to touch App.tsx or Layout.tsx (see `settings-registry-driven-wiring.md`)
2. `protocolPreferenceSchema.options` returns values in declaration order `['usenet', 'torrent', 'none']`, not alphabetical — affects dropdown option assertions (see `protocol-preference-schema-enum-order.md`)
3. Multi-category save payloads work naturally because `settings.service.ts` deep-merges partial updates per category — no special handling needed (see `multi-category-settings-save.md`)

## #385 Auto-grab paths missing indexerId — 2026-04-06
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #388

### Metrics
- Files changed: 11 | Tests added/modified: 11 new tests across 6 test files
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean field-forwarding bug — each module was a simple 1-line production fix + focused tests. Red/green TDD cycle was fast.
- Friction / issues encountered: Spec went through 3 rounds of review (autoGrabBestResult naming error, test boundary over-specification, RSS pollRss gap). The RSS gap was a legitimate miss — pollRss doesn't map indexerId unlike searchAll.

### Token efficiency
- Highest-token actions: Elaborate and respond-to-spec-review cycles (3 rounds)
- Avoidable waste: The initial spec could have caught the pollRss gap with deeper source reading
- Suggestions: When elaborating, always trace data flow from source to sink for ALL code paths, not just the obvious ones

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: Backend grab sites cherry-pick fields (same pattern as frontend SearchReleasesModal). A shared buildGrabPayload helper would prevent this class of bug.

### Wish I'd Known
1. `pollRss()` has a separate code path from `searchAll()` and doesn't inherit its field mapping — check ALL `SearchResult[]` producers when adding fields
2. The four grab call sites all cherry-pick fields manually — any new optional field on the grab schema will be silently dropped at these sites
3. Existing test assertions were too loose (`objectContaining` with 1-2 fields) — tightening them is cheap insurance

## #383 MAM account info card — consolidate status — 2026-04-06
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #384

### Metrics
- Files changed: 3 | Tests added/modified: 14 (8 new, 6 updated)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (test for "Unknown" classname needed detection path, not form hydration)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was very thorough after 3 rounds of review — all AC items were precise with line references. Implementation was a clean component swap.
- Friction / issues encountered: The "classname undefined → Unknown" test initially failed because `deriveInitialMamStatus` always fills classname. Had to restructure the test to use the detection path instead.

### Token efficiency
- Highest-token actions: Spec review response rounds (2 rounds before approval)
- Avoidable waste: None — the spec review rounds caught real issues (case sensitivity, failure path scope)
- Suggestions: None

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill unavailable (external plugin)
- Unresolved debt: None introduced

### Wish I'd Known
1. `deriveInitialMamStatus` always provides a classname fallback — the `?? 'Unknown'` card fallback only activates via detection, not form hydration (see `derive-initial-status-fills-classname-fallback.md`)
2. Refresh button title string was used as a test selector 12 times across 2 files — `replace_all` is essential for this kind of rename (see `mam-account-card-test-blast-radius.md`)
3. The spec had significant prerequisite overlap with #372 — 3 original ACs were already done. Elaboration caught this early, saving implementation time.

## #357 Activity page download card polish — 2026-04-06
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #382

### Metrics
- Files changed: 9 | Tests added/modified: 17 (15 new + 2 updated)
- Quality gate runs: 2 (fail on attempt 1 — complexity, pass on attempt 2)
- Fix iterations: 1 (extracted DownloadTitle/DownloadMetadata to fix ESLint complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD cycle was clean — all 58 existing tests survived the `renderWithProviders` migration unchanged. Type change blast radius was caught immediately by typecheck.
- Friction / issues encountered: ESLint complexity limit (15) hit after adding 4 new conditional branches to DownloadCard. Required extracting 2 helper components. The optional-to-nullable type change (`seeders?: number` → `seeders: number | null`) broke 7 inline fixtures in SearchReleasesModal.test.tsx that weren't using the shared factory.

### Token efficiency
- Highest-token actions: Explore subagent for plan codebase exploration (read full test file at 541 lines)
- Avoidable waste: Could have predicted the complexity violation from the plan (4 new conditionals added to a component already near the limit)
- Suggestions: Check current complexity before adding branches — `npx eslint --rule 'complexity: [warn, 15]' <file>` as a pre-flight

### Infrastructure gaps
- Repeated workarounds: Inline Download fixtures in SearchReleasesModal.test.tsx don't use `createMockDownload()` — they'll break again on any Download type change
- Missing tooling / config: No automated blast radius check for type changes — could be a pre-commit script
- Unresolved debt: DownloadActions dead code (#306 — already logged in debt.md)

### Wish I'd Known
1. Changing optional to nullable in TypeScript breaks inline fixtures that omit the field, not just those that set it to undefined — grep `**/*.test.*` for the type name before committing (see `optional-to-nullable-blast-radius.md`)
2. Adding a `<Link>` to any component requires migrating ALL existing tests to `renderWithProviders` — plan it as step 0, not as a reaction to test failures (see `render-to-renderWithProviders-migration.md`)
3. ESLint complexity of 15 is tight — count existing branches before adding new ones, and pre-plan extraction if approaching the limit

## #371 Unify settings registries — co-locate UI field components with entity registries — 2026-04-06
**Skill path:** /elaborate → /respond-to-spec-review (x3) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #381

### Metrics
- Files changed: 16 | Tests added/modified: 4 (2 new invariant test files, 2 updated test files)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure file extraction refactoring — existing tests caught any issues immediately. The barrel export pattern for client-side registries was clean and obvious.
- Friction / issues encountered: Spec review took 3 rounds due to cascading precision issues (file reference → defaults gap → coverage matrix → narrative mismatch). Each round was one finding.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds × full issue body read + comment parsing)
- Avoidable waste: The 3 spec review rounds could have been 1 if the initial elaboration had done a full programmatic diff of SETTINGS_DEFAULTS vs registry entries
- Suggestions: When elaborating issues that remove parallel maps, always run a programmatic diff to catch ALL gaps, not just the obvious ones

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Frontend design skill not available — skipped design pass
- Unresolved debt: Updated file path in debt.md for DetectionOverlay (moved from IndexerFields.tsx to indexer-fields/mam-fields.tsx)

### Wish I'd Known
1. The notifier registry had 5 missing fields, not 3 — a simple programmatic diff of SETTINGS_DEFAULTS keys vs all registry entries would have caught this upfront (see `notifier-settings-defaults-gap.md`)
2. The existing IndexerCard.tsx already uses INDEXER_TYPES[0] — no change needed there, saving one module of work
3. The barrel export pattern with `Record<string, Component>` type is the cleanest OCP pattern for client-side component registries that can't live in `shared/`

## #369 Download and serve cover images locally — 2026-04-06
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #380

### Metrics
- Files changed: 7 | Tests added/modified: 34
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (coverage review found 3 gaps — updatedAt assertion, fire-and-forget log assertion, startup wiring test)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec simplification to reuse existing `coverUrl` + `/api/books/:id/cover` contract eliminated all schema/route/frontend changes. Clean 4-module TDD cycle with no surprises.
- Friction / issues encountered: Initial spec had 2 rounds of spec review before approval (author images had no infrastructure, fetchWithTimeout throws on redirects, backup claim was wrong). Elaboration could have caught these upfront.

### Token efficiency
- Highest-token actions: Elaborate + 2 respond-to-spec-review cycles (3 full issue reads + codebase exploration each)
- Avoidable waste: First elaboration produced a spec with author images and new DB columns — the spec reviewer correctly caught these misalignments. Checking existing contracts during elaboration would have saved 2 review rounds.
- Suggestions: During elaboration, always grep for existing field/route contracts before proposing new ones.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `fetchWithTimeout` uses `redirect: 'manual'` and throws on 3xx — CDN image downloads need native `fetch` with `redirect: 'follow'` (see `fetch-with-timeout-redirect-manual.md`)
2. The existing `coverUrl` field already carries both local (`/api/books/:id/cover`) and remote (http) URLs — no new DB columns were needed. Checking this during elaboration would have saved 2 spec review rounds (see `spec-simplification-reuse-contract.md`)
3. The embedded cover branch in enrichment-utils has a `!book.coverUrl` guard that skips extraction when a remote URL exists — the fire-and-forget hook must check `!update.coverUrl` (not `!book.coverUrl`) to avoid false triggers (see `enrichment-utils-cover-precedence.md`)

## #368 Limit concurrent M4B merge jobs with queue — 2026-04-06
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #379

### Metrics
- Files changed: 19 | Tests added/modified: ~87
- Quality gate runs: 3 (pass on attempt 3 — lint max-lines, unused import, SSE event count)
- Fix iterations: 3 (max-lines extraction, typecheck generic, SSE test count update)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec review process caught real contract issues (merge_complete dual definition, missing pre-enqueue validation, useBookActions caller surface). The existing Semaphore utility + import service admission pattern made the queue implementation straightforward.
- Friction / issues encountered: The deprecated `mergeBook()` method couldn't delegate to `executeMerge()` because mock `readdir` calls were consumed during validation then unavailable for execution. Had to keep duplicated validation+execution logic in `mergeBook` rather than DRY refactoring.

### Token efficiency
- Highest-token actions: Spec review rounds (3 comments x full body reads), Explore subagents for plan + self-review + coverage review
- Avoidable waste: Could have anticipated max-lines violation earlier and planned extraction from the start
- Suggestions: When adding >50 lines to a service file, check `wc -l` before writing tests

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No linting pre-check for file size before implementation
- Unresolved debt: Deprecated `mergeBook()` duplicates validation logic (logged in debt.md)

### Wish I'd Known
1. ESLint max-lines (400) is enforced — adding queue management + emit methods + deprecated compat method blew past the limit, requiring extraction mid-handoff
2. `readdir` mock consumption ordering matters when a deprecated sync method delegates to an async method that re-reads the same path — keep validation and execution in the same call chain
3. The `safeEmit` generic pattern needs `<T extends SSEEventType>` with explicit SSE types imported — `Parameters<...>` extraction doesn't resolve correctly through Fastify's EventBroadcaster interface

## #372 MAM: auto-refresh status before search, remove search type dropdown — 2026-04-06
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #378

### Metrics
- Files changed: 20 | Tests added/modified: ~50 new test cases across 8 test files
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint complexity + typecheck)
- Fix iterations: 2 (cyclomatic complexity in MamFields extracted to helpers; unused classname property removed from adapter)
- Context compactions: 0

### Workflow experience
- What went smoothly: Red/green TDD cycle worked well per module; spec was very well-defined after 3 rounds of spec review, making implementation straightforward
- Friction / issues encountered: Cyclomatic complexity limit (15) was tight after adding status messaging — needed to extract `persistMamFields()` and `MamSearchStatusMessage` components. TypeScript strict mode caught unused `classname` property early.

### Token efficiency
- Highest-token actions: Explore subagents for plan and self-review; reading large test files
- Avoidable waste: The spec review cycle (3 rounds) consumed significant context before implementation started; could have been more precise in the initial spec
- Suggestions: For future issues with cross-cutting type changes (3+ layers), define all type contracts upfront in the spec

### Infrastructure gaps
- Repeated workarounds: Test fixture `MamFieldWrapper` scoped inside describe blocks — had to re-create wrappers in new test blocks
- Missing tooling / config: No `frontend-design` skill available for UI polish pass
- Unresolved debt: TestResult type defined in 3 parallel locations (DRY-1)

### Wish I'd Known
1. The adapter's `classname` property is metadata-only — not read by `search()`. Don't add adapter instance fields for data that's only needed by the service layer for DB persistence. Return it in the method result instead.
2. Removing a UI element (search type dropdown) cascades to 9+ tests across 3 files — always grep test files for the label text before starting fixture cleanup.
3. The `preSearchRefresh()` shared helper pattern keeps both search methods clean and under complexity limits — extract shared pre-flight logic early rather than duplicating inline.

## #367 qBittorrent adapter: fetch .torrent URLs instead of rejecting — 2026-04-06
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #377

### Metrics
- Files changed: 3 | Tests added/modified: 18
- Quality gate runs: 2 (pass on attempt 2 — lint complexity + typecheck fix)
- Fix iterations: 2 (cyclomatic complexity extraction, TS2339 catch type)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean implementation — existing `addDownloadFromFile` and `fetchWithTimeout` infrastructure made the change straightforward. Spec was well-groomed after 2 review rounds.
- Friction / issues encountered: Cyclomatic complexity hit 18 after inlining the fetch logic — had to extract to private method. Also hit TS2339 because `.catch((e: Error) => e)` on `Promise<string>` produces `string | Error` union type.

### Token efficiency
- Highest-token actions: Elaborate + 2 spec review rounds consumed significant context before implementation started
- Avoidable waste: Could have extracted `fetchAndUploadTorrent` from the start instead of inlining and then refactoring
- Suggestions: For methods near complexity limit, always extract new logic into separate methods upfront

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None new

### Wish I'd Known
1. `fetchWithTimeout` redirect errors include `Location` header in message — any URL-redacting caller must sanitize (learning: `fetchwithtimeout-redirect-leaks-location.md`)
2. Adding a try/catch + if/else branch to an already-complex method will exceed complexity 15 — extract from the start (learning: `eslint-complexity-extract-early.md`)
3. `.catch((e: Error) => e)` on `Promise<string>` returns `string | Error` — use `as Error` cast in tests

## #373 Fix download completion race condition — monitor overrides adapter status — 2026-04-06
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #375

### Metrics
- Files changed: 11 | Tests added/modified: 45+
- Quality gate runs: 2 (pass on attempt 2 — first failed on ESLint complexity)
- Fix iterations: 1 (extracted postProcFailed helper to reduce NZBGet mapHistoryStatus complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: Red/green TDD per module worked cleanly — 5 modules, each with clear test→implement→commit cycle. Existing test patterns in each adapter were consistent enough to follow.
- Friction / issues encountered: Deluge mock fixture needed `is_finished: false` default added, which cascaded to an existing "maps Seeding state correctly" test that expected `seeding` but now correctly returns `downloading`. Transmission status mapping tests needed `leftUntilDone` in the fixture, which changed the parameterized test expectations.

### Token efficiency
- Highest-token actions: Explore subagents for plan and self-review
- Avoidable waste: None significant — the elaboration phase was thorough and prevented spec review round-trips during implementation
- Suggestions: Multi-adapter changes benefit from the per-module TDD approach — each adapter is independent so can be committed atomically

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: QG orchestrator O(N) scan already logged from #358

### Wish I'd Known
1. **NZBGet's unknown status default was `completed`** — the most dangerous possible default. The existing test was asserting the bug. Always check what the default/fallback case returns in status mapping functions. (See: `nzbget-unknown-default-completed-bug.md`)
2. **Deluge's `Seeding` state ≠ finished** — `is_finished` is the authoritative flag. Adding `is_finished` to the fixture cascaded to existing tests that assumed Seeding=seeding. (See: `deluge-is-finished-vs-seeding-state.md`)
3. **Transmission's `isFinished` means ratio-limit-reached, not download-complete** — `leftUntilDone === 0` is the correct completion check. Field naming is actively misleading. (See: `transmission-leftuntildone-vs-isfinished.md`)

## #365 Library page: sort/search/dropdown cleanup — 2026-04-06
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #374

### Metrics
- Files changed: 8 | Tests added/modified: 14
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (sort dropdown direction order was desc-first for all fields, needed per-field ordering)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 4-module TDD cycle, each module isolated with clear boundaries. Self-review and coverage review passed quickly.
- Friction / issues encountered: Sort dropdown direction order required field-specific mapping — the original `['desc', 'asc']` put Title Z→A before A→Z. Caught in red phase by exact-order assertions.

### Token efficiency
- Highest-token actions: Explore subagent for plan codebase exploration (read many test files to understand patterns)
- Avoidable waste: None significant — the issue was well-scoped and the spec review had already clarified all contracts
- Suggestions: For UI-only changes, targeted file reads are more efficient than full Explore subagents

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available for design pass
- Unresolved debt: None introduced

### Wish I'd Known
1. Sort dropdown direction order is field-dependent — `['desc', 'asc']` is correct for Date Added but wrong for alphabetical fields. See `sort-dropdown-direction-order.md`.
2. `collapseSeries` returned items in Map insertion order, not re-sorted — this was the root cause of the series grouping sort bug. See `collapse-series-sort-key-mismatch.md`.
3. The regex `/a.*z/i` matches both "A→Z" and "Z→A" — use exact string matching for sort option assertions.

## #361 MAM status refresh button silently fails for saved indexers — 2026-04-05
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #366

### Metrics
- Files changed: 4 | Tests added/modified: 13
- Quality gate runs: 3 (pass on attempt 3 — lint unused var, then typecheck literal widening, then pass)
- Fix iterations: 2 (blur-with-sentinel regression caught by test, TS literal widening in extracted payload)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-refined after spec review round-trip. Backend already supported sentinel resolution via `testIndexerConfig` with `id` — pure frontend fix. Explore subagent identified all touch points accurately.
- Friction / issues encountered: Blur handler regression — initial implementation allowed sentinel through when indexerId present, but blur fires with pre-populated sentinel value. Test caught it immediately. TypeScript literal widening when extracting payload to a variable — had to inline it.

### Token efficiency
- Highest-token actions: Explore subagent for codebase validation (thorough but necessary — identified the two-path asymmetry)
- Avoidable waste: None significant — clean implementation path
- Suggestions: For similar masked-credential bugs, check both blur and refresh paths upfront

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available (noted in handoff)
- Unresolved debt: None introduced

### Wish I'd Known
1. Blur and refresh paths must be treated asymmetrically for sentinel handling — blur fires with pre-populated values, refresh is intentional user action. See `sentinel-blur-vs-refresh-asymmetry.md`.
2. Extracting inline API payloads to local variables widens TypeScript string literals — keep payloads inline or use `as const`. See `ts-literal-widening-in-spread-payload.md`.
3. The `testIndexerConfig` API already accepts `{ id?: number }` and resolves sentinels server-side — no backend changes needed at all.

## #363 MAM searchType sends integer instead of string — VIP filter broken — 2026-04-05
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #364

### Metrics
- Files changed: 13 | Tests added/modified: ~60 across 7 test files
- Quality gate runs: 2 (pass on attempt 2 — first failed due to MamSearchType literal return type)
- Fix iterations: 1 (TypeScript narrowing for Zod enum return type)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-elaborated after 3 review rounds — all files and line numbers accurate, coercion helper suggested upfront
- Friction / issues encountered: Test helper functions scoped inside `describe()` blocks caused `ReferenceError` when new sibling blocks tried to use them — had to duplicate helpers

### Token efficiency
- Highest-token actions: Reading 7 test files for blast radius sweep, multiple replace_all cycles for numeric→string fixture updates
- Avoidable waste: Could have done a single bulk replace pass across all test files instead of file-by-file
- Suggestions: For type-system-wide changes, scan ALL files with the old type first, then batch replacements

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available for dropdown polish
- Unresolved debt: None introduced

### Wish I'd Known
1. `coerceSearchType` return type must be `MamSearchType` (literal union), not `string` — Zod enum schemas propagate narrow types through form `defaultValues` (see `zod-enum-narrows-form-types.md`)
2. Test helper functions in `describe()` blocks are scoped — can't be shared across sibling `describe()` blocks without duplication (see `test-helper-scope-in-describe-blocks.md`)
3. The factory at `registry.ts` was already missing `isVip` forwarding before this issue — auto-select logic was dead code on the production path for saved indexers

## #321 Centralize blacklist reason enum to single source of truth — 2026-04-05
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #362

### Metrics
- Files changed: 6 | Tests added/modified: 1 (5 new test cases)
- Quality gate runs: 2 (pass on attempt 2 — first attempt hit unrelated flaky test in IndexerFields.test.tsx)
- Fix iterations: 1 (unused import in test file caught by typecheck)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean DRY-1 fix following established `as const` tuple pattern from notification-events.ts and registry modules. All 12 test files with blacklist reason fixtures passed without modification since values were unchanged.
- Friction / issues encountered: Spec review round had a false-positive F1 (reviewer's grep missed `user_cancelled` in codebase) — required dispute with evidence. Minor ordering issue: `satisfies Record<BlacklistReason, string>` required `BlacklistReason` type to be declared before `REASON_LABELS`, so type derivation moved from Zod `z.infer` to direct tuple derivation.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration (comprehensive but necessary for blast radius verification)
- Avoidable waste: None — the elaborate + spec-review cycle was front-loaded before /implement
- Suggestions: For pure type-level refactors, the coverage review subagent could be skipped (all changes are compile-time)

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `DiscoveredBook` type in library-scan has the same DRY-1 pattern (3 parallel definitions) — logged in debt.md line 16

### Wish I'd Known
1. The `satisfies` keyword preserves the declared type while enforcing the constraint — this is why `notification-events.ts` uses `Record<string, string>` as the declared type with `satisfies Record<NotificationEvent, string>`, not a direct type annotation
2. Drizzle `text('col', { enum: [...] })` needs a mutable array — `as const` tuples require spread `[...TUPLE]` to work
3. The `BlacklistReason` type needed to be derived directly from the tuple (`typeof BLACKLIST_REASONS[number]`) rather than from `z.infer` to allow use in `satisfies` before the Zod schema was declared — ordering matters in single-file modules

## #358 Inline import after download completion — eliminate import polling — 2026-04-05
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #360

### Metrics
- Files changed: 10 | Tests added/modified: 27 new + updated existing
- Quality gate runs: 3 (pass on attempt 2 — first failed on complexity/line-count, third had unrelated flaky test)
- Fix iterations: 2 (complexity 16→15 via method extraction, max-lines 406→396 via comment consolidation)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was extremely well-specified after 4 rounds of spec review — implementation was straightforward with no ambiguity
- Friction / issues encountered: Shared test fixture mutation across tests (const object passed by reference, mutated by production code via `book.status = 'importing'`); e2e test in multi-entity relied on removed `handleBookStatusOnCompletion` behavior

### Token efficiency
- Highest-token actions: Spec review responses (4 rounds) consumed significant context before implementation began
- Avoidable waste: None — the spec review rounds prevented implementation rework
- Suggestions: The processOneDownload method's use of getCompletedDownloads() + .find() is O(N) — a dedicated query would be cleaner but wasn't worth the scope creep

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: No integration test for service factory wiring (routes/index.ts createServices) — all service tests use createMockServices
- Unresolved debt: processOneDownload queries all completed downloads to find one by ID (logged in debt.md)

### Wish I'd Known
1. The in-memory book status mutation after DB write is critical for revert guards — without it, held/rejected downloads leave the book stuck in 'importing'. This was specified in the spec but the interaction with the existing revert guards was subtle.
2. Test fixtures at describe scope are shared by reference — spreading `{ ...fixture }` is mandatory when production code mutates the object. Cost me one test debug cycle.
3. The maintenance cron ordering contract (QG before import) is load-bearing because `getEligibleDownloads()` queries both `completed` and `processing_queued` — without QG running first, raw completed downloads bypass quality gate entirely.

## #353 Move indexer and download client forms into modals — 2026-04-05
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #359

### Metrics
- Files changed: 13 | Tests added/modified: 27
- Quality gate runs: 2 (pass on attempt 2 — lint fix for unused eslint-disable)
- Fix iterations: 1 (unused eslint-disable directive)
- Context compactions: 0

### Workflow experience
- What went smoothly: Red/green TDD cycle was clean — each module's tests failed predictably, then passed after implementation. The `CrudSettingsPage` modal prop approach kept changes minimal and backwards-compatible.
- Friction / issues encountered: Spec review took 5 rounds due to reviewer's stale checkout missing existing artifacts (`DetectionOverlay`, `ManualAddFormModal`). The `stopPropagation()` vs `stopImmediatePropagation()` distinction for same-target document listeners was the key technical insight.

### Token efficiency
- Highest-token actions: Spec review cycle (5 rounds of /respond-to-spec-review before approval)
- Avoidable waste: The first 2 dispute rounds could have been avoided if the spec had included exact line-number references from the start
- Suggestions: Include verifiable `grep` commands in spec artifacts to short-circuit reviewer disputes

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill was unavailable — UI polish pass skipped
- Unresolved debt: `DetectionOverlay` no longer dims full viewport (see debt.md)

### Wish I'd Known
1. `stopPropagation()` does NOT work between handlers on the same DOM target — use `stopImmediatePropagation()` for same-target isolation (ref: `document-listener-escape-isolation.md`)
2. Adding an opt-in `modal` prop to a shared container is cleaner than refactoring the container — preserves existing consumer behavior by default (ref: `crud-settings-modal-opt-in.md`)
3. `useEscapeKey` + `ToolbarDropdown` both use document-level keydown — the isolation pattern needs both sides (producer prevents, consumer checks `defaultPrevented`)

## #352 Persist library filters in URL search params across navigation — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #356

### Metrics
- Files changed: 2 | Tests added/modified: 74
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint)
- Fix iterations: 1 (lint error: module-level variable mutation in render → moved to useEffect)
- Context compactions: 0

### Workflow experience
- What went smoothly: Single-file hook change with comprehensive test coverage. Existing LibraryPage tests passed without modification — good sign the interface contract was preserved.
- Friction / issues encountered: Test file needed .tsx extension for JSX (MemoryRouter wrapper). React lint rule caught module-level variable mutation in the UrlCapture test helper — had to restructure to use useEffect. usePagination doesn't support initial page from constructor, requiring a one-shot useEffect with ref guard.

### Token efficiency
- Highest-token actions: Writing the full test file (74 tests, ~700 lines)
- Avoidable waste: Could have planned the .tsx extension from the start instead of renaming after first failure
- Suggestions: When adding useSearchParams to a hook, immediately plan for Router wrapper in all tests

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: usePagination could accept an optional `initialPage` parameter to avoid the ref-guarded useEffect pattern
- Unresolved debt: None introduced

### Wish I'd Known
1. Adding `useSearchParams` to a hook breaks ALL existing `renderHook()` calls — plan the wrapper migration upfront
2. React's `react-hooks/globals` lint rule catches even `.current` mutations on plain objects during render — must use `useEffect` for test side-channels
3. `usePagination` doesn't accept initial page, requiring a one-shot effect with ref guard to set page from URL

## #351 Series badge — show total book count with prominent styling — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #355

### Metrics
- Files changed: 4 | Tests added/modified: 6
- Quality gate runs: 2 (pass on attempt 2 — first had TS error from `collapsedCount` on `BookWithAuthor`)
- Fix iterations: 1 (added `DisplayBook` type import to table test for type safety)
- Context compactions: 0

### Workflow experience
- What went smoothly: Straightforward text+CSS change, spec was well-defined with exact file paths and line numbers
- Friction / issues encountered: `createMockBook()` factory returns `BookWithAuthor` which doesn't include `collapsedCount` — needed explicit `DisplayBook` type annotation in table tests

### Token efficiency
- Highest-token actions: Explore subagent for self-review (overkill for a 33-line diff)
- Avoidable waste: Self-review subagent could have been skipped for trivial diffs
- Suggestions: Consider a diff-size threshold to skip self-review for very small changes

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: `frontend-design` skill not available (noted in handoff)
- Unresolved debt: none introduced

### Wish I'd Known
1. Trivial issue with no surprises — no learnings to capture
2. The `createMockBook()` factory doesn't include `DisplayBook` fields — need explicit typing when testing table view with `collapsedCount`
3. There was a second test referencing "+N more" text in the "collapsed series card display" describe block (line 349-354) beyond the main badge tests

## #350 Persist Audnexus genres during enrichment — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #354

### Metrics
- Files changed: 8 | Tests added/modified: 16 new tests + 23 updated call sites
- Quality gate runs: 2 (pass on attempt 2 — first failed on lint complexity + typecheck)
- Fix iterations: 2 (cyclomatic complexity extraction, null-to-undefined type coercion)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-groomed through 3 review rounds — all ambiguities resolved before implementation. Existing patterns (fill-if-empty, fire-and-forget telemetry) made the implementation straightforward.
- Friction / issues encountered: Cyclomatic complexity limit hit at 16 when adding genre logic to `applyAudnexusEnrichment` — required extracting `applyEnrichmentData()`. TypeScript mismatch between Drizzle's `string[] | null` and utility `string[] | undefined` parameter.

### Token efficiency
- Highest-token actions: Spec review response rounds (3 rounds before approval), codebase exploration subagent
- Avoidable waste: None significant — spec grooming prevented implementation rework
- Suggestions: Pre-check complexity budget of target methods during /plan

### Infrastructure gaps
- Repeated workarounds: null-vs-undefined coercion at Drizzle/utility boundaries
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `applyAudnexusEnrichment` was already at complexity 15 — one more branch would bust the limit. Should have planned the extraction from the start (see `cyclomatic-complexity-genre-addition.md`).
2. Drizzle nullable JSON columns produce `string[] | null` while many utility functions accept `string[] | undefined` — always budget for a coercion at the boundary (see `null-vs-undefined-genre-types.md`).
3. Widening a job function signature propagates to 20+ test call sites — enumerate all callers during planning, not discovery (see `enrichment-job-signature-propagation.md`).

## #348 MAM adapter — populate guid from torrent ID for blacklist support — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #349

### Metrics
- Files changed: 4 | Tests added/modified: 10
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (toHaveBeenCalledWith assertion pattern needed adjustment for TanStack mutation context)
- Context compactions: 0

### Workflow experience
- What went smoothly: Minimal production code change (1 line adapter, 3 lines client). Spec review caught the client forwarding gap early — saved a full review round-trip.
- Friction / issues encountered: `toHaveBeenCalledWith` doesn't work with TanStack Query mutation mocks because the mutationFn receives 2 args (variables + context). Had to switch to `mock.calls[0][0]` pattern.

### Token efficiency
- Highest-token actions: Spec review response rounds (3 rounds before approval)
- Avoidable waste: None — the spec review rounds caught real bugs (client forwarding gap, ABB scope claim)
- Suggestions: For future adapter field additions, always trace the full data path in the spec: adapter → client → API → DB

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: ABB adapter also lacks guid (separate issue); handleGrab cherry-picks fields instead of spreading (fragile pattern)

### Wish I'd Known
1. SearchReleasesModal.handleGrab() cherry-picks fields — adding a field to SearchResult requires explicit forwarding in 3 places in the component (see learning: mam-guid-client-forwarding-gap.md)
2. TanStack Query mutationFn gets 2 args — toHaveBeenCalledWith won't work, use mock.calls[0][0] (see learning: toHaveBeenCalledWith-mutation-context.md)
3. ABB adapter has the same guid gap as MAM — scope boundary claims about "other adapters" need mechanical verification

## #340 Test cleanup — MAM search type, blacklist cancel, lint — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #347

### Metrics
- Files changed: 1 | Tests added/modified: 0
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Trivial 2-line change, existing 79 tests confirmed no behavioral regression
- Friction / issues encountered: Spec review bot used stale codebase data, requiring a full dispute round before approval. All 4 blocking findings were factually wrong — artifacts existed on main.

### Token efficiency
- Highest-token actions: Spec review dispute round (elaborate → respond-to-spec-review cycle)
- Avoidable waste: The spec review bot's stale data caused an entire wasted review round
- Suggestions: None for implementation — the issue itself was minimal

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Spec review bot should verify against origin/main, not a cached snapshot
- Unresolved debt: None introduced

### Wish I'd Known
1. AC 2 and AC 3 were already done on main — the issue could have been scoped to just AC 1 from the start
2. The `|| undefined` on lines 163-164 is NOT redundant after removing it from 149-150 (converts `false` → `undefined`) — worth keeping
3. Trivial issue, no other surprises

## #342 Within-scan duplicate detection for import discoveries — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #346

### Metrics
- Files changed: 12 | Tests added/modified: 45 new assertions across 6 test files
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (ImportCard test used `getByRole('checkbox')` but the component renders a styled button with aria-label, not an input[type=checkbox])
- Context compactions: 0

### Workflow experience
- What went smoothly: Red/green TDD worked well across all 7 modules. The spec was thorough after 3 rounds of spec review, making implementation straightforward with no ambiguity.
- Friction / issues encountered: Hook test mock ordering — `useLibraryImport` auto-scans on mount, so test overrides must use `mockReset()` before `renderHook()`, not just `mockResolvedValue()` after `beforeEach`.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds with explore subagents) consumed significant context before implementation started
- Avoidable waste: None significant — the elaborate/review cycle was necessary given initial spec gaps
- Suggestions: For future enum-extension features, a checklist of "all call sites that branch on the enum" would save exploration time

## #341 Emit book_added event when a book is created — 2026-04-04
**Skill path:** /elaborate → /respond-to-spec-review (×2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #345

### Metrics
- Files changed: 11 | Tests added/modified: 15 new + 2 fixed
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (test stubs placed in wrong describe scope, fixed before commit)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean TDD cycle — red/green per module, all tests passed on first verify run. The fire-and-forget event pattern is well-established in the codebase, making implementation straightforward.
- Friction / issues encountered: Spec review took 2 rounds (10 findings total) — initial spec had wrong method names, contradictory architecture, missing call sites, wrong endpoint, and wrong source values. Thorough elaboration before claim prevented implementation rework.

### Token efficiency
- Highest-token actions: Two spec review response rounds consumed significant context reading comments and composing fixes. The Explore subagent for plan was also heavy.
- Avoidable waste: The elaborate → respond-to-spec-review cycle could have been shorter if the initial spec was more accurate. The second review round caught mechanical mismatches (wrong endpoint, wrong source values) that could have been caught in the first elaboration.
- Suggestions: When elaborating, verify ALL literal values (endpoint paths, source enum values) against the codebase, not just structural claims.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: DiscoveredBook type defined in 3 places (DRY-1) — logged in debt.md

### Wish I'd Known
1. **`isDbDuplicate` helper pattern**: When splitting boolean behavior (isDuplicate) into sub-categories, a centralized predicate prevents drift across 10+ call sites — see `isdbduplicate-helper-pattern.md`
2. **Hook test mock ordering**: `useLibraryImport` auto-scans on mount, so mock overrides must happen before `renderHook()` via `mockReset()` — see `hook-test-mock-ordering.md`
3. **ImportCard uses styled buttons, not checkbox inputs**: The select/deselect control is a `<button>` with `aria-label`, not `<input type="checkbox">` — tests must query by role+name, not role alone

### Infrastructure gaps (#341)
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known (#341)
1. Adding a fire-and-forget event before an existing one shifts `mock.calls` indices — tests that use `[0]` index will break. Always filter by event type. (See `event-history-call-order-test-fragility.md`)
2. DiscoveryService was the only BookService.create() caller missing EventHistoryService injection — checking constructor signatures against the service graph would have flagged this earlier. (See `discovery-service-missing-event-history.md`)
3. Library-scan uses `source: 'manual'` for all events (not 'auto') despite being triggered by a scan — the source taxonomy reflects user initiation, not automation.

## #339 MAM auto-detect — proxy leak, sentinel handling, and badge persistence — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #344

### Metrics
- Files changed: 11 | Tests added/modified: 21
- Quality gate runs: 2 (pass on attempt 2 — first failed on ESLint complexity)
- Fix iterations: 1 (MamFields complexity 21 > 15, extracted helpers)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD cycle worked well — red/green per module caught assertion issues early (service test needed fakeRow assertion fix vs objectContaining)
- Friction / issues encountered: ESLint complexity limit hit on MamFields after adding badge hydration + formTestResult bridge + useProxy passthrough. Prior learning from #317 warned about this but extraction wasn't done upfront.

### Token efficiency
- Highest-token actions: Explore subagent for plan (comprehensive codebase read), coverage review subagent
- Avoidable waste: Could have extracted MamFields helpers preemptively instead of post-verify
- Suggestions: When adding 3+ new conditionals to a MAM component, extract pure helpers first

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available for UI polish pass
- Unresolved debt: None introduced

### Wish I'd Known
1. The ESLint complexity limit (15) is easily hit when adding conditional hydration + bridge patterns to form components — extract pure helpers (`deriveInitialMamStatus`, `metadataToMamStatus`) before writing the component body (see `eslint-complexity-mam-fields-extraction.md`)
2. The generic `registerCrudRoutes` test route shares the `createSchema` for body validation — adding optional fields requires `z.ZodObject.extend()` with a runtime Zod import, not a type-only import (see `crud-routes-zod-extend-for-test-schema.md`)
3. For badge hydration from persisted values, pass initial state to `useState()` in the hook constructor rather than using `useEffect` — avoids flash-of-empty on edit form open (see `mam-badge-hydration-derive-vs-useeffect.md`)

## #334 Loose audio files at scan root bundled as phantom book — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #338

### Metrics
- Files changed: 2 | Tests added/modified: 15 (14 new, 1 updated)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Single-file bug fix with clear spec. TDD cycle was clean — 10 tests failed red, all passed green after a 9-line production change. One existing test needed updating (it tested the buggy behavior).
- Friction / issues encountered: Spec review took 3 rounds due to `audioChildren` vs `immediateAudioChildren` conflation — the distinction is subtle but critical for disc-merge correctness.

### Token efficiency
- Highest-token actions: Spec review response rounds (3 rounds of elaborate + respond-to-spec-review)
- Avoidable waste: None — the spec review rounds caught a real disc-merge interaction bug that would have failed in PR review
- Suggestions: For book-discovery changes, always note the audioChildren/immediateAudioChildren distinction upfront

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None discovered

### Wish I'd Known
1. `audioChildren` (deep recursive) vs `immediateAudioChildren` (direct audio) is the critical variable distinction in collectBooks() — confusing them in specs breaks disc-merge
2. The existing "parent as leaf" test at line 486 was testing the exact buggy behavior — updating it (not deleting) was the right call
3. The fix is structurally a guard reorder: the new mixed-content check becomes the `if`, the old leaf check becomes `else if`, and the fall-through to disc-merge/recursion handles both mixed-content and no-audio cases

## #335 Match confidence — duration threshold too strict + manual match doesn't clear Review — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #337

### Metrics
- Files changed: 6 | Tests added/modified: 13 new + 1 updated
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (existing test broke due to threshold change — updated test to use low-score candidate)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean separation of backend and client modules; red/green TDD cycle was straightforward; `scored[]` array already had `.score` field so no refactoring needed
- Friction / issues encountered: Existing duration test at line 355 used `sampleCandidate` (score 1.0) with 8.3% duration diff — under new tiered logic this became `high` instead of `medium`. Had to update the test to use a low-score candidate to preserve its intent of testing the strict threshold.

### Token efficiency
- Highest-token actions: Explore subagent for plan exploration (comprehensive but needed for test pattern discovery)
- Avoidable waste: None — small, focused change
- Suggestions: For threshold changes, pre-identify all tests that implicitly depend on the threshold value before starting implementation

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: DRY-2 duplication of confidence upgrade logic in useManualImport/useLibraryImport (logged to debt.md)

### Wish I'd Known
1. The `scored[]` array already contains `.score` — no signature change needed for `resolveConfidenceFromDuration` (saved investigation time)
2. Existing tests that use `sampleCandidate` (perfect match, score 1.0) implicitly test the relaxed threshold after the change — they need updating to use low-score candidates for strict threshold coverage
3. Both import hooks have identical confidence upgrade logic — the DRY violation is minor (3 lines) but worth tracking as debt

## #333 Folder parsing — Series–Number–Title pattern in 2-part paths — 2026-04-04
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #336

### Metrics
- Files changed: 2 | Tests added/modified: 15
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean additive change to pure functions — no DB, no FS, no wiring. Red/green TDD was straightforward since all tests are self-contained unit tests on exported/private functions.
- Friction / issues encountered: The spec review correctly identified that the original spec pointed at the wrong control flow branch (parseSingleFolder vs parseFolderStructure 2-part branch). Two spec review rounds were needed to fix alignment issues before implementation could start.

### Token efficiency
- Highest-token actions: Spec review rounds (elaborate + respond-to-spec-review) consumed significant context before implementation started
- Avoidable waste: None — the spec review rounds were necessary to catch the control flow misalignment
- Suggestions: For parser bugs, always verify which branch handles the failing input before writing the spec

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `parseFolderStructure` has separate branches for 1-part, 2-part, and 3+ part paths — the 2-part branch never calls `parseSingleFolder`, so fixing only `parseSingleFolder` wouldn't fix the reported 2-part-path bug
2. The variable-length parsing gotcha (check more specific patterns first) was already documented in CLAUDE.md — checking there first would have saved investigation time
3. The regex `[–-]` character class handles both en-dash and hyphen in a single pattern — no need for separate regex branches

## #331 Audio preview — replace native player with simple play button — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #332

### Metrics
- Files changed: 3 | Tests added/modified: 2 new + 2 updated
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Minimal change — single production line edit, clear spec, existing event wiring needed no modification
- Friction / issues encountered: None — spec review finding F1 (BookDetails.test.tsx blast radius) caught the only sibling impact upfront

### Token efficiency
- Highest-token actions: Explore subagents (elaborate + plan + self-review) — overkill for a 1-line fix
- Avoidable waste: Full explore for trivial issues; could short-circuit for issues with ≤3 file changes
- Suggestions: Consider a "trivial fix" fast path that skips deep codebase exploration when spec is self-contained

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available (noted in handoff)
- Unresolved debt: None discovered

### Wish I'd Known
1. Trivial issue with no surprises — no learnings to capture. The spec review finding F1 was the only non-obvious detail and it was caught pre-implementation.
2. The `hidden` HTML attribute is cleaner than `className="hidden"` for elements that should never be visible — it's semantic and doesn't depend on Tailwind.
3. N/A — issue was too straightforward for a third insight.

## #322 Add 'Add Book' button to library empty state — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #330

### Metrics
- Files changed: 4 | Tests added/modified: 11
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean frontend-only feature with well-defined AC. Red/green TDD cycle worked perfectly — 2 modules (NoMatchState, SearchPage) each had clear test boundaries. The `useSearchParams` approach was simpler than `useEffect` for URL param initialization.
- Friction / issues encountered: Coverage review flagged missing LibraryPage integration test for the searchQuery prop wiring — caught before push.

### Token efficiency
- Highest-token actions: Explore subagent for self-review and coverage review
- Avoidable waste: None significant — small feature kept context lean
- Suggestions: For simple frontend features, self-review could be done inline

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill unavailable for UI polish pass
- Unresolved debt: None introduced

### Wish I'd Known
1. `useSearchParams` is synchronous on first render — no `useEffect` needed for URL param → state initialization. Avoids REACT-4 entirely.
2. `URLSearchParams({ q: value }).toString()` handles all encoding automatically — matches existing pattern in `src/client/lib/api/search.ts`.
3. Coverage review will flag integration tests for prop wiring even when both ends have unit tests — always add at least one parent-level test for new prop passthrough.

## #320 Audio preview button for imported books — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #329

### Metrics
- Files changed: 9 | Tests added/modified: 27 (17 backend + 8 frontend + 2 integration)
- Quality gate runs: 4 (pass on attempt 4 — lint fixes for max-lines and complexity, route registry count)
- Fix iterations: 3 (max-lines extraction, complexity disable, registry count)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean spec with full error contract table and MIME mappings made implementation straightforward. Existing file-serving patterns (cover/files endpoints) provided clear templates.
- Friction / issues encountered: books.ts was near the 400-line lint limit — adding the preview route exceeded it, requiring extraction into book-preview.ts mid-verify. Should have planned extraction from the start given the file was at 367 lines.

### Token efficiency
- Highest-token actions: Elaborate + two spec review response rounds consumed significant context before implementation began
- Avoidable waste: Could have checked books.ts line count upfront to plan extraction
- Suggestions: For files near max-lines, always plan extraction proactively

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available for design pass
- Unresolved debt: None introduced

### Wish I'd Known
1. `books.ts` was at 367 of 400 max lines — should have planned to extract the preview route into its own file from the start
2. jsdom resolves `audio.src = ''` to the base URL, not empty string — cleanup assertions need `not.toContain` instead of `toBe('')`
3. Fastify `reply.send(stream)` handles backpressure automatically — no need for raw socket patterns like in SSE streaming

## #317 MAM adapter — VIP detection and smart search filtering — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #328

### Metrics
- Files changed: 17 | Tests added/modified: 36
- Quality gate runs: 2 (pass on attempt 1, then again after coverage fixes)
- Fix iterations: 1 (ESLint complexity/max-lines on MamFields — extracted hook and components)
- Context compactions: 0

### Workflow experience
- What went smoothly: Core adapter changes (types, MAM adapter, result flags) were straightforward with clear spec. TDD cycle worked well — 13 tests failed as expected on first run, all passed after implementation.
- Friction / issues encountered: Adding `useQueryClient()` to `useConnectionTest` broke all 12 existing tests because the test file was `.test.ts` (no JSX) and used bare `renderHook` without provider. Had to use `createElement` pattern. ESLint complexity/max-lines caught the MamFields bloat early via verify.ts.

### Token efficiency
- Highest-token actions: Explore subagent for codebase investigation, self-review and coverage review subagents
- Avoidable waste: Coverage review flagged some false positives (ReleaseCard badges were already tested but subagent didn't find them)
- Suggestions: For future multi-layer features, plan the hook extraction upfront to avoid the lint → refactor cycle

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available for design pass
- Unresolved debt: SearchResult type duplication between core and client (DRY-1)

### Wish I'd Known
1. Adding `useQueryClient()` to a hook used by `.test.ts` files (not `.test.tsx`) requires `createElement` wrapper — JSX isn't available. Check test file extensions before adding provider-dependent hooks.
2. ESLint complexity limit (15) is easily hit when adding async blur detection with loading/error/success states to form components. Extract the hook and display components upfront.
3. The shared `CrudService` interface in `crud-routes.ts` had `ip?` returned by all adapters but not declared — the interface was already out of sync. Adding `metadata?` required fixing `ip?` too.

## #323 Fix QB path resolution — use content_path — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #327

### Metrics
- Files changed: 3 (2 source, 1 test) | Tests added: 8
- Quality gate runs: 2 (pass on both — once mid-implement, once at handoff)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Very contained fix — single `mapItem()` method change with clear fallback logic. MSW mocks already had `content_path`, so no fixture updates needed. Red/green TDD cycle was clean — 3 tests failed exactly as expected (mismatched name, nested path, mixed batch).
- Friction / issues encountered: None — the spec review cycle had already identified all caller surfaces (import, quality gate, monitor), so implementation was straightforward.

### Token efficiency
- Highest-token actions: Elaborate + spec review response consumed most context before implementation started
- Avoidable waste: None significant — the fix was small and well-scoped
- Suggestions: For adapter-level fixes like this, the coverage subagent can be skipped (small diff threshold works well)

### Wish I'd Known
1. MSW mock fixtures were already ahead of the schema — checking test mocks first would have confirmed the fix surface immediately (see `qb-content-path-ahead-of-schema.md`)
2. `.passthrough()` on Zod schemas silently passes unknown fields — this is why `content_path` worked in e2e tests without being typed
3. All three downstream path consumers (`resolveSavePath`, `resolveOutputPath`, `download-path.ts`) share the identical `join(savePath, name)` pattern — fixing the adapter was sufficient for all

## #324 UAT polish — round 1 — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #326

### Metrics
- Files changed: 21 | Tests added/modified: 13 test files
- Quality gate runs: 4 (pass on attempt 4 — lint fixes, e2e update, type fix)
- Fix iterations: 3 (placeholder text in existing test, e2e assertion for book status, coverUrl null→undefined type)
- Context compactions: 0

### Workflow experience
- What went smoothly: The 6 polish items were well-scoped and independent — could implement sequentially with clean commits per module. TDD red/green cycle worked cleanly for each module.
- Friction / issues encountered: The BookHero overflow menu change had a massive blast radius in BookDetails.test.tsx (40+ lines needed openOverflowMenu + role query changes). Multiple sed/node passes were needed to fix all patterns. The spec review cycle was unusually long (6 rounds) due to a reviewer codebase index mismatch on the server-backup restore surface.

### Token efficiency
- Highest-token actions: BookDetails.test.tsx blast radius fixes (multiple read-edit-test cycles), spec review dispute rounds
- Avoidable waste: Could have checked BookDetails.test.tsx references BEFORE implementing the overflow menu to plan the migration
- Suggestions: When extracting inline buttons into menus, grep all test files for button text references first and plan the migration

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available (skipped design pass)
- Unresolved debt: None new

### Wish I'd Known
1. Moving inline buttons to overflow menu breaks ALL parent component tests that reference those buttons — check blast radius first (see `overflow-menu-test-blast-radius.md`)
2. The backup restore pipeline has a clear 3-guard pattern (monitor promote + QG revert + import dedupe) that must be implemented atomically (see `monitor-book-status-pipeline-interaction.md`)
3. Changing a service from throw-on-error to return-error-result propagates cleanly through routes but requires updating ALL existing test assertions from `.rejects.toThrow()` to result checks (see `restore-contract-return-not-throw.md`)

## #318 Add minimum seed ratio setting for torrent removal — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #325

### Metrics
- Files changed: 20 | Tests added/modified: 41 new tests across 4 files + 17 fixture updates
- Quality gate runs: 2 (pass on attempt 2 — lint complexity + typecheck on attempt 1)
- Fix iterations: 1 (lint complexity in quality-gate-orchestrator extracted to helper)
- Context compactions: 0

### Workflow experience
- What went smoothly: Schema + registry + shared helper were straightforward. Test patterns well-established.
- Friction / issues encountered: Import service tests required double `mockResolvedValueOnce` for adapter because `resolveSavePath` and `handleTorrentRemoval` both call `getDownload`. QGO mock adapter missing `getDownload` caused silent failures swallowed by try-catch.

### Token efficiency
- Highest-token actions: Fixture blast radius update (17 files) delegated to subagent — good use of parallelism
- Avoidable waste: Could have anticipated the double-mock issue earlier by reading `resolveSavePath` flow before writing tests
- Suggestions: For features that add adapter calls, check all call sites of the adapter method before writing test mocks

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: `frontend-design` skill not available for UI polish pass
- Unresolved debt: none introduced

### Wish I'd Known
1. `adapter.getDownload()` is called by `resolveSavePath` during `importDownload()` — any test exercising import needs the full adapter response mocked first, then the ratio response second
2. QGO test suite's `mockAdapter` was incomplete (missing `getDownload`) — errors in new code paths are silently swallowed by the orchestrator's try-catch, making debugging hard
3. Self-review step is critical for deferred cleanup methods — the `adapter!` non-null assertion and missing `deleteAfterImport` guard would have been blocking review findings

## #315 Cancel download should also blacklist the release — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #319

### Metrics
- Files changed: 12 | Tests added/modified: 16
- Quality gate runs: 2 (pass on attempt 2 — complexity lint fix)
- Fix iterations: 1 (extracted `blacklistCancelledRelease()` to fix cyclomatic complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-refined after 2 rounds of spec review — all contract surfaces, operation ordering, and field names were pre-verified, eliminating implementation guesswork
- Friction / issues encountered: First verify run failed on complexity lint (cancel() at 17, max 15). Required extracting a private method. Minor but added an extra commit cycle.

### Token efficiency
- Highest-token actions: Spec review response rounds (2 rounds before approval), explore subagent for plan
- Avoidable waste: None significant — spec reviews caught real issues early
- Suggestions: For small features, the explore subagent could be scoped more tightly

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available — skipped design pass
- Unresolved debt: `isBlacklisted()` only checks infoHash not guid (pre-existing, already in debt.md)

### Wish I'd Known
1. `DownloadService.cancel()` is called internally by `grab(replaceExisting)` — adding behavior there leaks into replacement flow (see `orchestrator-vs-service-cancel-scope.md`)
2. The blacklist field is `blacklistType` not `type` — easy to assume wrong, caught in spec review round 2 (see `blacklist-field-name-blacklisttype.md`)
3. The orchestrator's `cancel()` was already at complexity 13 — adding a try/catch + if/else block pushed it over 15, requiring extraction

## #313 Add direct restore button for server-side backups — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #316

### Metrics
- Files changed: 9 | Tests added/modified: 21
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (extractDbFromZip cleanup ownership — temp dir leaked on non-zip input after refactor)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean extraction of shared pipeline from processRestoreUpload — the DRY refactor preserved all existing test behavior. Spec review cycle resolved the validation contract ambiguity upfront, preventing implementation guesswork.
- Friction / issues encountered: Test stubs were initially placed at the wrong describe scope in system.test.ts (standalone block without app/services access). Route test file has two top-level describes with different app configurations — stubs must target the correct parent.

### Token efficiency
- Highest-token actions: Explore subagents for plan and self-review
- Avoidable waste: None significant — the spec review cycle caught contract issues before implementation
- Suggestions: Route test stub placement could be automated by reading the test file structure during /plan

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available — UI polish pass skipped
- Unresolved debt: None introduced

### Wish I'd Known
1. When extracting shared logic from a method with try/catch cleanup, the new helper must own its own cleanup — the parent's catch no longer has access to the helper's local state (temp directories).
2. Route test stubs must go inside the correct top-level describe that has app/services in scope — system.test.ts has two such blocks with different Fastify configurations.
3. The spec's validation contract (throw on valid:false vs return 200) was the critical design decision — resolving it during spec review saved significant implementation time.

## #312 Fix #309 follow-up — invalidation spam and missing page-level test — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #314

### Metrics
- Files changed: 3 | Tests added/modified: 7 (5 hook-level + 2 page-level)
- Quality gate runs: 2 (fail on attempt 1 — ESLint complexity, pass on attempt 2)
- Fix iterations: 1 (extracted `invalidateFromRule` to reduce `handleEvent` complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean TDD cycle — red phase confirmed the counts-only test failed before the fix, all other tests passed after. Production fix was minimal (filter + flag).
- Friction / issues encountered: ESLint complexity limit hit after adding the `hasPageQueries` branch — needed to extract `invalidateFromRule`. Also `require()` doesn't work for path-aliased imports in Vite/ESM test context — had to use top-level `import` for `SSEProvider` in page tests.

### Token efficiency
- Highest-token actions: Explore subagent for codebase validation (comprehensive but necessary for spec review alignment)
- Avoidable waste: None significant — small focused change
- Suggestions: For follow-up bugs on recent PRs, the elaborate/spec-review cycle is heavy relative to the fix size

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `findAll` uses prefix matching and returns ALL queries with that prefix — including counts queries with incompatible shapes. This caused the original bug and required shape-based filtering.
2. ESM/Vite test environment doesn't support `require()` with path aliases (`@/`) — must use top-level `import` for test dependencies like `SSEProvider`.
3. `handleEvent` was already at ESLint complexity 15 before #310's patch — any new branch would require extracting helpers first. See `tanstack-findall-prefix-match-filtering.md`.

## #309 Activity page shows stale empty state after new download grab — 2026-04-03
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #310

### Metrics
- Files changed: 2 | Tests added/modified: 5 (4 new + 1 updated)
- Quality gate runs: 2 (pass on attempt 2 — first failed on ESLint complexity)
- Fix iterations: 1 (extracted patchActivityProgress helper to reduce complexity from 16 to under 15)
- Context compactions: 0

### Workflow experience
- What went smoothly: Small, well-scoped bug fix — spec clearly identified the exact lines and root cause. Red/green TDD cycle was clean.
- Friction / issues encountered: ESLint cyclomatic complexity limit hit after adding the cache-miss branch. Should have checked complexity before committing the first pass.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (thorough but proportionate to change size)
- Avoidable waste: Could have extracted the helper function upfront instead of needing a second commit
- Suggestions: For functions near complexity limit, extract helpers preemptively before adding branches

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `handleEvent` was already at complexity 15 — should have extracted the patch logic before adding the fallback branch (see `eslint-complexity-extract-before-adding-branches.md`)
2. TanStack Query's `setQueryData` gives no signal when a patch doesn't match any entity — you have to track hits manually (see `sse-patch-cache-miss-detection.md`)
3. The fix was entirely self-contained in one file — no blast radius concerns, which made the implementation very fast

## #306 Post-delivery polish — modal overflow, SSE limbo timeout, minor nits — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review (x3) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #308

### Metrics
- Files changed: 13 | Tests added/modified: 17 new tests across 7 test files
- Quality gate runs: 2 (pass on attempt 2 — first had exhaustive-deps lint)
- Fix iterations: 1 (missing `clearFinalizingTimeout` in useCallback deps)
- Context compactions: 0

### Workflow experience
- What went smoothly: Each AC was well-isolated — red/green TDD cycle was clean for all 6 items. Existing test patterns (MockEventSource, renderPendingReview helper) were well-established.
- Friction / issues encountered: Spec review went 3 rounds before approval (AC1 wrong root cause, AC5 row-scoping gap, AC6 untestable AC). Test stubs landed in wrong describe block initially (app.inject integration vs unit test block).

### Token efficiency
- Highest-token actions: 3 rounds of /respond-to-spec-review consumed significant context pre-implementation
- Avoidable waste: First spec review response introduced an incorrect root cause for AC1 (said outer max-h was missing when it already existed) — caught in round 2
- Suggestions: Read source more thoroughly before writing spec responses to avoid round-trips

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available — skipped design pass
- Unresolved debt: DownloadActions has dead PendingActionButtons branch for pending_review (hidden by parent)

### Wish I'd Known
1. `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` also breaks TanStack Query — not just full fakeTimers. Use real short timeouts + waitFor instead. (→ `fake-timers-break-tanstack-query-settimeout.md`)
2. The outer `max-h-[85vh]` on SearchReleasesModal already existed — the missing piece was `min-h-0` on the intermediate dialog div. Reading the full modal structure before spec responses would have saved a review round. (→ `flex-min-h-0-overflow-propagation.md`)
3. `mutation.variables` gives row-level scoping for free when a single mutation serves a list of items — no need for separate state tracking. (→ `mutation-variables-row-scoping.md`)

## #300 Quality comparison panel missing existing book codec, channels, and duration — 2026-04-02
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #307

### Metrics
- Files changed: 11 | Tests added/modified: 29 new tests, fixtures updated in 4 files
- Quality gate runs: 2 (pass on attempt 2 — first attempt failed on ESLint complexity)
- Fix iterations: 1 (refactored buildRows into row-builder helpers for complexity)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean additive pattern — type extension → helper population → readback normalization → UI display. Each module was self-contained with clear test boundaries.
- Friction / issues encountered: ESLint complexity limit (15) hit after adding conditional row logic to buildRows(). Needed to extract row builders.

### Token efficiency
- Highest-token actions: Explore subagent for plan codebase exploration, coverage review subagent
- Avoidable waste: None significant — blast radius was well-documented in spec
- Suggestions: Spec's fixture blast radius section was very helpful for scoping work

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill unavailable (external plugin)
- Unresolved debt: `resolveBookQualityInputs()` called twice in `buildQualityAssessment()` (pre-existing, logged to debt.md)

### Wish I'd Known
1. Adding conditional rows to a `buildRows()` function hits ESLint complexity fast — extract row-builder helpers from the start (see `eslint-complexity-row-builders.md`)
2. JSON stored in DB needs `NULL_REASON` spread on readback when new fields are added — `undefined !== null` breaks `!== null` guards (see `null-reason-spread-legacy-compat.md`)
3. The spec's fixture blast radius section was accurate and complete — trust it and update all listed files

## #296 Move 'Add manually' form into a modal on search results page — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #305

### Metrics
- Files changed: 4 | Tests added/modified: 16 new + 6 updated
- Quality gate runs: 2 (pass on attempt 2 — unused import lint fix)
- Fix iterations: 1 (unused `within` import)
- Context compactions: 0

### Workflow experience
- What went smoothly: Small, well-scoped frontend issue. Spec review caught real convention mismatches (backdrop-close). ManualAddForm was self-contained and didn't need refactoring — just wrapped in a modal.
- Friction / issues encountered: querySelector optional chain returning undefined vs null caught by test — easy fix but non-obvious pattern.

### Token efficiency
- Highest-token actions: Explore subagent for plan (read many modal files for pattern matching)
- Avoidable waste: None significant — issue was well-scoped
- Suggestions: For simple frontend refactors with established patterns, a lighter explore pass would suffice

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available — skipped UI polish pass
- Unresolved debt: None introduced

### Wish I'd Known
1. `querySelector()?.closest()` returns `undefined` not `null` — caused 7 test failures that all resolved with one `?? null` fix (see `queryselector-optional-chain-null.md`)
2. Every form modal in the app uses `closeOnBackdropClick={false}` — spec review caught this before implementation, saving a round-trip
3. Unmount/remount pattern for form reset is simpler than explicit reset on close (see `modal-form-reset-via-unmount.md`)

## #299 Quality gate orphan cleanup respects delete-after-import and deregisters from client — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #304

### Metrics
- Files changed: 15 | Tests added/modified: 22
- Quality gate runs: 2 (pass on attempt 2 — lint complexity violation on first)
- Fix iterations: 1 (extracted helper methods to reduce cyclomatic complexity from 17 to under 15)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec review cycle was thorough — caught the `bookId=null` misalignment and the broad `outputPath IS NOT NULL` selector before any code was written, saving significant rework
- Friction / issues encountered: The `pendingCleanup` column addition required updating download fixtures across 8 test files — tedious but the fixture blast radius check in `/elaborate` warned about this upfront

### Token efficiency
- Highest-token actions: Explore subagent during /elaborate and /plan (deep codebase reads)
- Avoidable waste: None significant — the spec review rounds were necessary to get the deferred cleanup design right
- Suggestions: For similar DB column additions, batch all fixture updates as the first module to avoid typecheck failures mid-implementation

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. The quality gate auto-reject path is via `performRejectionCleanup` called from `dispatchSideEffects`, not from `bookId=null` — the spec initially got this wrong (learning: `deferred-cleanup-marker-design.md`)
2. ESLint complexity limit (≤15) is easily reached with nested try/catch error isolation — plan for helper extraction upfront (learning: `eslint-complexity-extraction.md`)
3. Seed time boundary semantics: `elapsed < minSeedMs` means exactly-at-boundary does NOT defer — test titles must match (learning: `seed-time-boundary-semantics.md`)

## #301 Split reject into Reject (dismiss) and Reject & Search — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #303

### Metrics
- Files changed: 12 | Tests added/modified: 24 new + 13 updated
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (existing orchestrator tests needed `{ retry: true }` after default behavior change)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean separation of concerns — backend helper flag, orchestrator conditional, route schema, frontend prop threading all fell into place naturally
- Friction / issues encountered: Fastify's body schema validation rejected empty POST bodies when using Zod `.optional().default({})`. Switched to manual safeParse in handler.

### Token efficiency
- Highest-token actions: Elaborate + 2 rounds of spec review responses consumed significant context before implementation started
- Avoidable waste: Spec review caught the `rejected` status literal, `redownloadFailed` ambiguity, and null-qualityGate gap — these could have been caught during elaboration with deeper source reading
- Suggestions: During elaboration, always verify status literals and setting interactions against source code before writing spec

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: frontend-design skill not available — design pass skipped
- Unresolved debt: None introduced

### Wish I'd Known
1. Changing a method's default behavior (reject no longer blacklists) causes a blast radius across 9+ existing tests — grep for all callers before committing the production change
2. Fastify body schema validation via `schema: { body: zodSchema }` doesn't handle empty POST bodies gracefully with `.optional().default({})` — use safeParse in the handler instead
3. The `blacklistAndRetrySearch` helper separates blacklist eligibility (needs identifiers) from retry eligibility (needs book + deps) — reading the source before spec review would have prevented the F6 round-trip

## #298 Streaming search with indexer status view and per-indexer cancel — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #302

### Metrics
- Files changed: 18 | Tests added/modified: 6 test files (~110 new tests)
- Quality gate runs: 3 (pass on attempt 3 — 1st had lint, 2nd had flaky ActivityPage test)
- Fix iterations: 1 (self-review caught 3 bugs: empty session controllers, missing cancel events, missing getEnabledIndexers)
- Context compactions: 0

### Workflow experience
- What went smoothly: Module-by-module TDD approach worked well for this cross-cutting feature. AbortSignal threading was straightforward once the pattern was established.
- Friction / issues encountered: Massive test file refactoring when switching SearchReleasesModal from useQuery to useSearchStream — 40+ mock calls needed updating. Self-review caught critical bug where session was created with empty indexer list.

### Token efficiency
- Highest-token actions: SearchReleasesModal test file refactoring (1200+ lines, many individual edits), Explore subagent for codebase exploration
- Avoidable waste: Could have designed the session creation correctly from the start if the route pattern had been sketched before coding
- Suggestions: For SSE streaming features, sketch the data flow (who queries what, who creates what) before starting implementation

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Global EventSource stub was missing from test setup — had to add it
- Unresolved debt: searchAllStreaming and searchAll both independently query enabled indexers; flaky ActivityPage pagination test

### Wish I'd Known
1. Per-request SSE streams are architecturally different from the global broadcast channel — don't try to reuse the EventBroadcaster service or its event type registry
2. Session with AbortControllers must be populated with real indexer IDs before streaming starts — can't defer to the streaming method's internal DB query
3. Switching a component from useQuery to a custom hook requires wholesale test file refactoring — mock the hook module-level to minimize churn

## #295 Import settings — reorder fields and disable seed time when delete is off — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #297

### Metrics
- Files changed: 2 | Tests added/modified: 9 (6 new, 3 updated)
- Quality gate runs: 3 (pass on attempt 3 — lint warning then typecheck error)
- Fix iterations: 2 (eslint react-hooks/incompatible-library suppress, watch() return type cast)
- Context compactions: 0

### Workflow experience
- What went smoothly: Narrow scope, clear prior art in ProcessingSettingsSection, spec review caught real RHF behavior nuance
- Friction / issues encountered: Spec review round-trip on RHF disabled-field semantics required source-level verification of RHF internals to resolve correctly. `stripDefaults()` type erasure caused unexpected `unknown` return from `watch()`.

### Token efficiency
- Highest-token actions: Spec review response cycle (3 rounds of elaborate/respond), codebase exploration subagents
- Avoidable waste: The RHF disabled-field debate could have been resolved in round 1 with source-level evidence
- Suggestions: When a spec review disputes library behavior, verify against the actual library source immediately rather than relying on documentation claims

### Infrastructure gaps
- Repeated workarounds: `stripDefaults()` type erasure requires `as` casts on `watch()` — accepted debt
- Missing tooling / config: `frontend-design` skill not available for design pass
- Unresolved debt: None new — `stripDefaults()` already documented

### Wish I'd Known
1. RHF `handleSubmit` strips disabled field values ONLY when disabled is passed via `register({ disabled })` — HTML `disabled` attr is safe. Reading the bundled source (`node_modules/react-hook-form/dist/index.esm.mjs:2197-2200`) was the definitive proof.
2. `stripDefaults()` erases type information — `watch()` returns `unknown`, requiring explicit casts. ProcessingSettingsSection avoids this by defining its schema inline.
3. Adding `watch()` from RHF triggers a `react-hooks/incompatible-library` lint warning that must be suppressed — established pattern across 6+ files in the codebase.

## #291 MAM indexer — add language filter and search type settings — 2026-04-02
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #294

### Metrics
- Files changed: 11 | Tests added/modified: 24 new tests across 6 files
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (coverage review found missing schema validation tests; added 4)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was very well-defined after 2 rounds of review — default contract, exact language list, all artifact surfaces named. Implementation was mechanical.
- Friction / issues encountered: The spec review cycle (2 rounds) caught real issues: client/server boundary violation for constants, wrong test surfaces, wrong method name. These would have been expensive to fix during PR review.

### Token efficiency
- Highest-token actions: Elaborate + 2 respond-to-spec-review rounds consumed significant context before implementation started
- Avoidable waste: None — the spec precision paid off during implementation (zero ambiguity)
- Suggestions: None

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available — UI polish pass skipped
- Unresolved debt: FieldComponent type in IndexerFields.tsx now passes watch/setValue to all field components even though only MamFields uses them (minor, acceptable)

### Wish I'd Known
1. Making MAMConfig fields non-optional causes blast radius across 5 test constructor sites — enumerate all call sites before changing the interface
2. `??` vs `||` matters at every layer when settings have valid falsy values (0, []) — the spec review caught this before implementation, saving significant rework
3. React Hook Form `register()` doesn't work for numeric array fields — must use `setValue()`/`watch()` pattern (prior art in NotifierCard.tsx)

## #288 Migrate raw selects to SelectWithChevron in FilterRow and ImportSummaryBar — 2026-04-01
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #293

### Metrics
- Files changed: 4 source + 2 test + 1 debt.md | Tests added/modified: 10
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean migration — existing behavioral tests (aria-label queries, role queries) were transparent to the component swap. Red/green TDD worked well for the variant prop.
- Friction / issues encountered: Spec review round-trip was necessary — initial spec had a single "compact" variant that couldn't serve two callers with different padding/font-size. Resolved by splitting into shared base + caller className.

### Token efficiency
- Highest-token actions: Explore subagents for elaboration and plan (reading 6+ files each)
- Avoidable waste: Elaboration and plan subagents overlapped significantly in reading the same files
- Suggestions: For simple migration issues, a lighter-weight plan phase would suffice

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: `frontend-design` skill not available — skipped design pass
- Unresolved debt: None introduced

### Wish I'd Known
1. When adding a variant to a shared component, design the variant as a base that omits conflicting utilities and delegates caller-specific sizing to className — avoids Tailwind class override issues without `tailwind-merge`
2. Existing FilterRow/ImportSummaryBar tests use behavioral queries (aria-label, role, displayValue) that are component-structure agnostic — migration required zero test changes
3. The spec review process caught a real design flaw (single compact preset for two different sizing needs) that would have caused implementation confusion

## #289 Extract shared inputClass constants and ToggleSwitch component — 2026-04-01
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #292

### Metrics
- Files changed: 15 | Tests added/modified: 1 (ToggleSwitch.test.tsx, 11 new tests)
- Quality gate runs: 2 (fail on attempt 1 due to TS size prop conflict, pass on attempt 2)
- Fix iterations: 1 (HTML input `size` attribute conflict with custom `size` prop)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure refactoring with zero behavioral changes — all 147 existing tests passed without modification after toggle extraction. SelectWithChevron.tsx provided an exact forwardRef pattern to follow.
- Friction / issues encountered: TypeScript caught `size` prop conflict with HTML input's native `size` attribute. Required `Omit<..., 'size'>` fix. Also, `errorInputClass` had API divergence across files (string vs function) requiring call-site updates.

### Token efficiency
- Highest-token actions: Explore subagent for initial codebase analysis (reading all 8+ toggle files)
- Avoidable waste: Could have caught the `size` prop conflict during planning by checking `React.InputHTMLAttributes` interface
- Suggestions: When adding custom props to HTML element wrappers, always check for conflicts with native HTML attributes

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `CredentialsSection.tsx` and `ImportListProviderSettings.tsx` still have local `inputClass` duplication

### Wish I'd Known
1. HTML `<input>` has a native `size` attribute (number type) that conflicts with custom string union `size` props — always use `Omit` when extending HTML attributes with redefined prop names
2. `errorInputClass` had different APIs across files (static string vs function) — check all consumer patterns before choosing the shared API shape
3. The toggle pattern had 2 size variants (full/compact) with different slide distances — reading all callers before designing the component interface saves rework

## #287 Type safety cleanup — extractYear dedup, addDownload JSDoc, compareNullable fix — 2026-04-01
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #290

### Metrics
- Files changed: 6 | Tests added/modified: 7 (1 regression + 6 new sort tests)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (all-null descending test expectation corrected — stable sort preserves input order, not id-descending)
- Context compactions: 0

### Workflow experience
- What went smoothly: Small isolated fixes mapped cleanly to independent modules. Red/green TDD caught the all-null sort expectation mistake immediately.
- Friction / issues encountered: The original spec had 2 factual errors (seriesPosition "0" is truthy, Blackhole legitimately returns null). These were caught during `/elaborate` and `/respond-to-spec-review` before implementation — no wasted implementation effort.

### Token efficiency
- Highest-token actions: Explore subagents for elaborate/plan/self-review/coverage — 4 total
- Avoidable waste: The elaborate subagent's analysis contradicted the spec review on seriesPosition and addDownload — could skip elaborate for already-reviewed issues
- Suggestions: For multi-item cleanup issues, each item is independent enough to skip deep codebase exploration

### Infrastructure gaps
- Repeated workarounds: `.narratorr/state/` directory gets cleaned up between steps (mkdir -p needed repeatedly)
- Missing tooling / config: None
- Unresolved debt: None new

### Wish I'd Known
1. `compareNullable` returning a discriminated union is cleaner than adding a direction parameter — the null/value split maps naturally to "direction-independent" vs "direction-dependent" comparison (see `compare-nullable-direction-independence.md`)
2. JS string `"0"` is truthy — the original debt item was wrong. Always verify JS truthiness before assuming a falsy-check bug (see `js-string-zero-truthy.md`)
3. When all values compare equal (all-null case), `Array.sort` is stable and preserves input order — don't assume a secondary sort exists if the field isn't 'series'

