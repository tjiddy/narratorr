# Workflow Log

## #418 Extract shared SuggestionReason registry — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #424

### Metrics
- Files changed: 11 | Tests added/modified: 1 (6 new tests)
- Quality gate runs: 2 (pass on attempt 2 — first failed due to removed eslint-disable)
- Fix iterations: 2 (eslint-disable restoration, hardcoded settings default)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure refactor with clear scope — all existing tests passed unchanged after the swap. The download-status-registry pattern provided a clear template.
- Friction / issues encountered: Self-review caught a hardcoded `.default()` literal in settings schema that the implementation missed. The `eslint-disable max-lines` comment was accidentally removed when editing the first line of discovery.service.ts.

### Token efficiency
- Highest-token actions: Explore subagents for plan and coverage review
- Avoidable waste: Could have kept the eslint-disable on first edit instead of removing and re-adding
- Suggestions: When editing a file's first line, check for file-level eslint directives first

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory keeps getting lost between steps (mkdir -p needed repeatedly)
- Missing tooling / config: None
- Unresolved debt: discovery-weights.ts formula lacks dedicated unit tests; discovery.service.ts still over max-lines

### Wish I'd Known
1. When deriving Zod object shapes dynamically, the `.default()` value must ALSO be derived — easy to miss (see `zod-object-fromEntries-default.md`)
2. Removing a line that happens to be an `eslint-disable` breaks lint even if the underlying violation hasn't changed (see `eslint-disable-removal-trap.md`)
3. The `SUGGESTION_REASONS` array type from `z.enum().options` is already a readonly tuple — no need to re-annotate it (caused a TS error on first attempt)

## #404 Discover — Series Completion Intelligence — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #420

### Metrics
- Files changed: 1 | Tests added/modified: 16
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (two test assertions needed reason-filter refinement due to dedup map behavior)
- Context compactions: 0

### Workflow experience
- What went smoothly: Pure validation issue — all code existed from #366, just needed test coverage. Quick turnaround.
- Friction / issues encountered: 3 rounds of spec review ping-pong on fractional position worked example before approval. During test implementation, 2 of 16 tests failed initially because the candidate dedup map means author queries can "steal" candidates from series queries when author scores higher.

### Token efficiency
- Highest-token actions: Spec review response rounds (3 rounds), codebase exploration for plan
- Avoidable waste: The spec review could have been resolved in 1 round if the original fractional-position example had been traced step-by-step through the loop
- Suggestions: When writing worked examples for loops, always trace actual variable values (init, increment, each iteration)

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directories disappearing between steps (had to mkdir -p again)
- Missing tooling / config: None
- Unresolved debt: None new — all pre-existing debt items remain unchanged

### Wish I'd Known
1. The `generateCandidates` dedup map means `queryAuthorCandidates` runs first and can claim ASINs with `reason: 'author'` before `querySeriesCandidates` gets to them — always filter by `reason` in series-specific assertions (see `series-dedup-map-reason-override.md`)
2. `computeSeriesGaps()` loop inherits the fractional part from `Math.min(...)` — `for (let i = 1.5; ...)` increments to 2.5, never hitting integer 2 (see `fractional-loop-counter-trace.md`)
3. This issue was 100% validation work — the spec review took longer than the actual implementation

## #406 Discover — Dismissal Tracking and Score Weight Tuning — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #419

### Metrics
- Files changed: 10 | Tests added/modified: 31
- Quality gate runs: 2 (pass on attempt 2 — first had max-lines lint violation)
- Fix iterations: 1 (extracted pure functions to discovery-weights.ts, fixed form TS type)
- Context compactions: 0

### Workflow experience
- What went smoothly: TDD cycle worked well — each module had clear red→green phases. The pure function extraction (computeWeightMultipliers) made testing the formula trivially easy.
- Friction / issues encountered: Mock chain ordering was the biggest friction — adding one DB query to refreshSuggestions shifted all existing test mock chains. Had to manually update 9 existing tests. Also hit a TypeScript error from the shared schema change propagating to the frontend form component.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration, coverage review subagent
- Avoidable waste: Could have predicted the mock chain shift upfront and batched the fixture updates
- Suggestions: When adding a new DB query to a multi-query method, immediately enumerate all tests that mock that method's call chain

### Infrastructure gaps
- Repeated workarounds: Manual mock chain ordering in refreshSuggestions tests — a test helper that names mock returns by purpose (not position) would be more resilient
- Missing tooling / config: No way to test formula edge cases without going through the full service constructor — extracting to pure functions was the right call
- Unresolved debt: discovery.service.ts still over max-lines (added eslint-disable)

### Wish I'd Known
1. Adding a new db.select() call to refreshSuggestions would break ALL existing refresh tests due to mock chain ordering — should have enumerated affected tests before writing new ones
2. Shared settings schema changes propagate to frontend form components via TypeScript — the form type should derive from the form schema, not the full settings type
3. The max-lines lint violation was pre-existing (452 lines on main, limit 400) — discovery.service.ts already needed extraction before this issue

## #407 Discover — Diversity Factor (Filter Bubble Prevention) — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #417

### Metrics
- Files changed: 8 | Tests added/modified: 18
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 1 (mock isolation for diversity vs affinity queries in service tests)
- Context compactions: 0

### Workflow experience
- What went smoothly: Spec was well-defined after 3 rounds of review. The existing query*Candidates pattern made implementation straightforward — copy queryGenreCandidates, swap genre selection logic. No schema migration needed.
- Friction / issues encountered: Test mock isolation — blanket searchBooksForDiscovery mocks let affinity queries claim diversity ASINs first, causing 3 test failures. Required per-query-string mockImplementation to isolate affinity vs diversity search results.

### Token efficiency
- Highest-token actions: Self-review and coverage review subagents (~150k tokens combined)
- Avoidable waste: Spec review response (round 2) was called before /implement, costing an extra issue read cycle
- Suggestions: For additive enum changes, the self-review subagent is overkill — most findings are "correct" with no bugs to catch

### Infrastructure gaps
- Repeated workarounds: .claude/state/ directory sometimes gets cleaned up between steps, requiring mkdir -p
- Missing tooling / config: No shared SuggestionReason type — 8-file enum duplication is the biggest DX pain point in the discover feature area
- Unresolved debt: SuggestionReason enum duplication (see debt.md)

### Wish I'd Known
1. **Mock isolation is critical for multi-signal pipelines**: When testing diversity through generateCandidates(), affinity queries (author, genre, series, narrator) all call the same searchBooksForDiscovery mock — a blanket mock lets them steal diversity ASINs. Always use mockImplementation with query-string matching. (see learnings/diversity-mock-isolation.md)
2. **SQLite text enum changes are metadata-only**: No migration needed — saves a step in the workflow
3. **The existing filterAndScore() helper is fully generic**: It accepts any SuggestionReason, so diversity candidates flow through the same quality filter path as affinity candidates without any modification

## #408 Discover — Suggestion Lifecycle (Expiry, Snooze, Re-score) — 2026-03-17
**Skill path:** /respond-to-spec-review → /implement → /claim → /plan → /handoff
**Outcome:** success — PR #416

### Metrics
- Files changed: 14 | Tests added/modified: 34
- Quality gate runs: 3 (pass on attempt 3 — lint violation then typecheck error)
- Fix iterations: 2 (unused param lint, union type narrowing in test)
- Context compactions: 0

### Workflow experience
- What went smoothly: Module-by-module TDD cycle was clean — each module took 1 red/green pass. The mock helpers (createMockSettings deep merge, Proxy-based createMockServices) handled new fields automatically. Spec review response + implementation ran end-to-end without blocking.
- Friction / issues encountered: mockDbChain error simulation required `{ error: ... }` option, not a thrown function — burned a test iteration. Self-review caught snoozeUntil not being cleared on resurface, which would have been a blocking review finding.

### Token efficiency
- Highest-token actions: Explore subagent for codebase exploration (~85k tokens), coverage review subagent (~88k tokens)
- Avoidable waste: Could have skipped reading some test files in parallel since the patterns are consistent
- Suggestions: For issues with many modules but simple patterns, batch similar modules (e.g., client API + client test in one pass)

### Infrastructure gaps
- Repeated workarounds: Drizzle delete() result type casting for rowsAffected
- Missing tooling / config: No typed return from Drizzle delete operations
- Unresolved debt: computeResurfacedScore heuristic, SuggestionRow client/server duplication

### Wish I'd Known
1. **snoozeUntil must be cleared on resurface** — temporal fields that act as filters need lifecycle management. If a field controls visibility and its condition becomes permanently true, you get an infinite loop. Self-review caught this but a test would have been better.
2. **mockDbChain error injection uses `{ error }` option, not thrown functions** — the Proxy-based chain resolves promises, so you need Promise.reject not synchronous throws.
3. **Union type narrowing in tests** — when a service returns `T | 'conflict' | null`, TypeScript needs explicit narrowing before accessing properties on `T`. Use `if (result && result !== 'conflict')` guards.
