# Workflow Log

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
