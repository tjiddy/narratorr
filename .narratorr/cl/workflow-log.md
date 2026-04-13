# Workflow Log

## #541 Polish: sanitizeNetworkError URL leak, ebook filter test, mock drift — 2026-04-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #542

### Metrics
- Files changed: 5 | Tests added/modified: 7 new tests across 2 files, 1 mock refactor
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Three independent, well-scoped changes with clear AC. TDD cycle was fast — each module took one red/green pass with no iteration.
- Friction / issues encountered: Spec review took 3 rounds due to `Audiobook` not being in `AUDIO_FORMAT_RE` — the elaboration step used an incorrect example token. This was caught by the reviewer, not during planning.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds of elaborate → review-spec → respond cycles)
- Avoidable waste: Initial elaboration should have read `AUDIO_FORMAT_RE` source before choosing test examples
- Suggestions: When writing spec examples for filter tests, always read the actual regex/constant to pick valid tokens

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: search-pipeline.ts at 491 lines (soft limit 400) — pre-existing, not introduced

### Wish I'd Known
1. `AUDIO_FORMAT_RE` only matches codec format tokens (`m4b|mp3|flac|aac|ogg`), not genre words like `Audiobook` — would have saved 2 spec review rounds
2. The `importOriginal` passthrough mock pattern already existed in `import.service.test.ts:61-68` — searching for existing patterns before proposing solutions saves spec review friction
3. The ebook filter's `||` precedence chain is intentionally different from a "check all fields" approach — the ebook detection should use precedence (first non-empty field), but the audio counter-signal should check all fields independently

## #537 Activity page: merge Downloads + Event History into Active / History tabs — 2026-04-13
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #538

### Metrics
- Files changed: 11 | Tests added/modified: ~16 new tests, ~40 tests updated/removed
- Quality gate runs: 2 (pass on attempt 2 — lint violations fixed: complexity extraction, max-lines, unused import)
- Fix iterations: 1 (EventHistoryCard complexity 19>15 required extracting EventCardActions, EventHistorySection max-lines required moving retryMutation to useEventHistory hook)
- Context compactions: 0

### Workflow experience
- What went smoothly: Backend event recording was straightforward — existing pattern (recordGrabbedEvent) was a perfect template. TDD cycle worked well for all 5 modules.
- Friction / issues encountered: The spec went through 4 rounds of spec review before approval — initial Option A (client-side merge of two paginated endpoints) was fundamentally unsound. The key insight that resolved everything was recognizing bookEvents already captures the download lifecycle, making DownloadHistorySection redundant. This should have been caught during elaboration, not during spec review. ActivityPage test file rewrite was the highest-effort task — 57 tests needed updating due to coupled history/queue mock patterns.

### Token efficiency
- Highest-token actions: ActivityPage.test.tsx rewrite (delegated to subagent — correct decision given ~600 lines of test code needing structural changes)
- Avoidable waste: Reading the full EventHistoryCard test file (440 lines) could have been avoided with targeted grep
- Suggestions: For future tab restructure issues, start by checking what data each tab section actually consumes vs what events already capture

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: usePagination clamp effect pattern still present in EventHistorySection.tsx, BlacklistSettings.tsx, LibraryPage.tsx (existing debt item)

### Wish I'd Known
1. `bookEvents` already records most download lifecycle events — the "merge two data sources" approach in the original spec was unnecessary. Checking existing event writers first would have avoided 3 spec review rounds.
2. `EventHistoryCard` was already at cyclomatic complexity 15 — adding any conditional branch would exceed the limit. The Explore subagent flagged this but I didn't plan extraction upfront.
3. `useActivity` test file had deeply coupled queue/history mock patterns (`mockActivitySections` returning different data per section param, `toHaveBeenCalledTimes(2)` everywhere) — simplifying the hook required rewriting most tests rather than surgical edits.

## #532 fix: RSS multi-part filter runs before nzbName enrichment — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #536

### Metrics
- Files changed: 2 | Tests added/modified: 10
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0 (clean implementation)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec had already been through elaborate + spec-review + respond-to-spec-review, so the implementation was unambiguous. The #533 search-pipeline fix provided an exact template to follow.
- Friction / issues encountered: None significant. The `.narratorr/state/` directory got cleaned up between phases requiring `mkdir -p` recreation.

### Token efficiency
- Highest-token actions: Explore subagent in /plan (codebase was already well-understood from /elaborate)
- Avoidable waste: The /plan Explore subagent duplicated much of the /elaborate exploration — for sequential issues in the same area, the plan could have been lighter
- Suggestions: For follow-up issues to recently completed work (#533 → #532), the plan phase could skip deep exploration and rely on the recent context

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `rss.test.ts` is now 875 lines — approaching the soft limit but still manageable

### Wish I'd Known
1. The RSS enrichment is per-book (inside the matching loop) while search-pipeline enrichment is global — this structural difference was the key constraint for the fix and caused 2 spec review rounds
2. The `matched` count semantic change was non-obvious but intentional — multi-part rejection is a quality filter, not a matching filter, so matched books whose candidates are all rejected should still count
3. The `||` vs `??` operator distinction for title precedence chains is a recurring pattern — empty string nzbName from failed NZB parse must fall through, which `??` would not allow

## #533 fix: search multi-part filter runs before nzbName enrichment — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #535

### Metrics
- Files changed: 2 | Tests added/modified: 10
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (regression test expected nzbName to be ignored when present and clean — corrected test expectation)
- Context compactions: 0

### Workflow experience
- What went smoothly: Small, focused change — one function reorder plus operator change. TDD caught the regression test expectation error immediately.
- Friction / issues encountered: Spec review required 2 rounds — the blocking finding about `enrichUsenetLanguages()` skipping `!r.language` results was not obvious from the code without reading the full enrichment function. The `/elaborate` → `/respond-to-spec-review` cycle was productive.

### Token efficiency
- Highest-token actions: Explore subagent during /elaborate (read enrichment function, all callers, test patterns)
- Avoidable waste: The Explore subagent in /plan partially duplicated /elaborate exploration
- Suggestions: When /elaborate has already run, /plan could reuse findings from the elaborate verdict

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: search-pipeline.ts still ~491 lines (existing debt item)

### Wish I'd Known
1. `enrichUsenetLanguages()` has a `!r.language` guard that skips language-pre-populated results — this scope limitation was the blocking spec review finding and cost an extra review round
2. The `||` vs `??` operator difference at line 294 was the actual semantic bug beyond just ordering — `??` doesn't skip empty strings, `||` does. See `or-vs-nullish-coalescing-title-precedence.md`
3. One regression test (rawTitle marker with clean nzbName) needed rewriting because `nzbName || rawTitle` precedence means nzbName takes priority — the test was asserting old behavior

## #520 fix: ebook filter skips nzbName — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #534

### Metrics
- Files changed: 2 | Tests added/modified: 4
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Minimal scope issue — one line fix, straightforward TDD cycle
- Friction / issues encountered: Spec review took 3 rounds due to progressively discovering that multi-part filters (both search and RSS) run before nzbName enrichment. Each round removed one more out-of-scope AC. The data-flow ordering was the core insight.

### Token efficiency
- Highest-token actions: Spec review rounds (3 full review+response cycles before implementation)
- Avoidable waste: The original spec could have been narrowed to ebook-only from the start if enrichment ordering had been checked during elaboration
- Suggestions: During /elaborate, always trace the data-flow path for any field the spec assumes is available — check when it's populated relative to when it's consumed

### Wish I'd Known
1. `nzbName` is only populated by `enrichUsenetLanguages()` — any filter running before it gets undefined. This eliminated 2 of 3 originally-planned ACs (see `.narratorr/cl/learnings/nzbname-enrichment-ordering.md`)
2. `filterAndRankResults()` ends at line 254; the multi-part filter at line 290 is in `postProcessSearchResults()` — different function, different caller surface
3. The issue was truly 1-line fix, 4-test addition. Spec review rounds consumed ~80% of total effort — correct for spec quality, but the implementation itself was trivial

## #525 fix: import slot release should nudge queued downloads instead of waiting for next cron tick — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #531

### Metrics
- Files changed: 4 source + 3 test | Tests added/modified: 16 new
- Quality gate runs: 2 (pass on both)
- Fix iterations: 1 (activity test asserted on real semaphore function instead of spy — fixed assertion)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean TDD cycle — each module was small and self-contained. Existing mock patterns were easy to follow.
- Friction / issues encountered: Activity route tests use real Semaphore functions for tryAcquireSlot/releaseSlot (not mocks), so standard spy assertions fail on those methods.

### Token efficiency
- Highest-token actions: Spec review rounds (3 rounds before approval) dominated context
- Avoidable waste: Spec elaboration could have caught the SSE dedupe conflict earlier
- Suggestions: When adding CAS-style status changes, always check downstream consumers of the target status value

### Infrastructure gaps
- Repeated workarounds: `rowsAffected` cast pattern (no typed Drizzle API for this)
- Missing tooling / config: None
- Unresolved debt: QGO file at 498 lines (pre-existing, line 26 of debt.md)

### Wish I'd Known
1. `ImportOrchestrator.importDownload()` skips download SSE when status is already `importing` — this is the "approve-path dedupe" and any new path that pre-sets `importing` must emit SSE explicitly (see `import-orchestrator-sse-dedupe.md`)
2. Activity route tests use real Semaphore instances, not mocks — spy assertions on `releaseSlot`/`tryAcquireSlot` will fail (see `activity-test-real-semaphore.md`)
3. Drizzle `db.update()` return type needs an unsafe cast to access `rowsAffected` (see `drizzle-rowsaffected-cast.md`)

## #524 Discover page: use standard addBook flow instead of parallel book-creation pipeline — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review (x2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #530

### Metrics
- Files changed: 14 | Tests added/modified: 16 new tests across 6 test files
- Quality gate runs: 3 (pass on attempt 3 — first two had typecheck failures from cascading dep removal)
- Fix iterations: 2 (1: DiscoverRouteDeps had stale downloadOrchestrator prop; 2: bookService/eventHistory removed from constructor but skipped tests still referenced them)
- Context compactions: 0

### Workflow experience
- What went smoothly: Red/green TDD per module worked well. The 5-module plan (schema → wire contract → route → client → blast radius) was the right granularity.
- Friction: Removing `addSuggestion` cascaded into removing constructor deps (bookService, eventHistory), which cascaded into updating route wiring and test factories. TypeScript only reports one error at a time, so it took 2 verify runs to catch all cascading failures.

### Token efficiency
- Highest-token actions: Reading all existing test files during plan phase; editing the large discovery.service.test.ts file (2500+ lines)
- Avoidable waste: Could have removed old tests in one pass instead of first trying describe.skip (which still gets typechecked)
- Suggestions: When removing a service method, plan for 3 cascading layers (method → deps → callers) and handle all in one commit

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling: none
- Unresolved debt: BookMetadata client/server type drift (existing debt item from #497)

### Wish I'd Known
1. `describe.skip()` blocks are still type-checked — deleting test blocks is the only clean option when removing methods they reference
2. Removing a service method cascades into constructor dep removal, which cascades into route wiring and test factory updates — plan all 3 layers upfront
3. `mapBookMetadataToPayload` omits `publishedDate` — this was caught in spec review but would have caused a subtle data regression if missed

## #527 Extract DownloadUrlResolver — resolve download URLs before handing to adapters — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #528

### Metrics
- Files changed: 19 | Tests added/modified: 12 (37 new + 11 updated)
- Quality gate runs: 2 (pass on attempt 2 — first had ESLint complexity violations)
- Fix iterations: 1 (extracted helpers to reduce complexity in resolveHttp and grab)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-elaborated after 2 review rounds. Parallel subagents for adapter test updates were very effective (5 agents, all succeeded). TDD cycle for the resolver worked well — 37 tests written before implementation, all passed after.
- Friction / issues encountered: Short magnet hashes in service test fixtures (`btih:abc`) caused 20 cascade failures when the resolver added validation. Took time to identify and fix all instances. The `rejects.toThrow()` with callback functions doesn't work in Vitest — had to use `.catch()` pattern instead.

### Token efficiency
- Highest-token actions: Reading 6 adapter source files + their tests for context. Parallel subagent launches for test file updates.
- Avoidable waste: Could have grepped for all `addDownload` callsites across tests up front before starting implementation — would have identified the magnet hash issue earlier.
- Suggestions: For interface changes, build a full callsite inventory (including test mocks) before changing the interface. Batch-replace short fixture hashes proactively.

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: SABnzbd/NZBGet lack byte-upload paths (logged in debt.md)

### Wish I'd Known
1. Test fixtures with abbreviated magnet hashes (`btih:abc`) are widespread in service tests — any upstream validation change causes cascade failures. Always use full 40-char hex hashes. (See `short-magnet-hashes-in-tests.md`)
2. `node:crypto` in barrel exports breaks the Vite client build — check barrel import chains before adding re-exports. (See `crypto-in-barrel-breaks-vite.md`)
3. Interface signature changes have 2x the blast radius you'd expect — every mock in every test file needs updating, not just the implementation files. (See `interface-change-blast-radius.md`)

## #523 Search page should filter or deprioritize metadata results by configured languages — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review (×2) → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #529

### Metrics
- Files changed: 2 | Tests added/modified: 9
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean extraction pattern — `filterAuthorBooks()` provided an exact template for the new `filterBooksByLanguage()` method. All 9 new tests passed on first green run.
- Friction / issues encountered: Spec review took 3 rounds (2 rounds of `/respond-to-spec-review`). Round 2 caught a caller-surface gap — `GET /api/metadata/search` serves 3 client hooks, not just the search page. This was a legitimate miss in the original spec.

### Token efficiency
- Highest-token actions: Spec review round-trips (3 rounds of review comments)
- Avoidable waste: The caller-surface analysis could have been done in `/elaborate` if we'd grepped for all consumers of `api.searchMetadata()` upfront
- Suggestions: When elaborating specs that modify shared API endpoints, always enumerate all client consumers in the first pass

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: `BookMetadata` client/server type drift (already in debt.md from #497)

### Wish I'd Known
1. `GET /api/metadata/search` is consumed by 3 hooks, not just `useMetadataSearch` — would have scoped the spec correctly in the first elaboration pass
2. `filterAuthorBooks()` does dual filtering (reject words + languages) — knowing this upfront made the extraction decision obvious
3. The metadata.service.ts file was at 346/350 line limit — the shared method extraction was necessary, not just a DRY nicety

## #522 Polish: batch review findings from PRs 509-519 — 2026-04-13
**Skill path:** /elaborate → /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #526

### Metrics
- Files changed: 15 | Tests added/modified: 6 test files updated + 1 new test
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (mechanical transform script broke 7 test calls with comma-in-string literals)
- Context compactions: 0

### Workflow experience
- What went smoothly: The module-by-module approach worked well — BYTES_PER_GB extraction first (smallest), then the big options bag refactor, then smaller independent changes. Each commit was independently testable.
- Friction / issues encountered: The mechanical transform script for ~132 test callsites broke on string literals containing commas ('German, Abridged'). Required manual post-fix of 7 lines. Also, moving `isContentFailure` to a mocked module required adding the function to the mock factory — `importOriginal` failed due to heavy module dependencies.

### Token efficiency
- Highest-token actions: Reading and transforming ~132 `filterAndRankResults` test callsites across 2 test files
- Avoidable waste: Could have written a more robust transform script that tracks quote depth, avoiding the manual fixup pass
