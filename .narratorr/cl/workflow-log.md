# Workflow Log

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

