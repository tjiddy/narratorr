# Workflow Log

## #3 Remove password minimum length requirement — 2026-03-19
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #4

### Metrics
- Files changed: 4 | Tests added/modified: 2 (1 new, 1 updated)
- Quality gate runs: 2 (pass on attempt 2 — first had flaky ImportSettingsSection test)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Trivial issue, clean red/green TDD cycle, blast radius check found nothing
- Friction / issues encountered: gh not on PATH in bash — required PATH prefix

### Token efficiency
- Highest-token actions: Explore subagents — overkill for a 4-file change
- Avoidable waste: Three explore subagents for removing a constraint is heavy
- Suggestions: Consider fast-path for trivial chores

### Infrastructure gaps
- Repeated workarounds: gh PATH issue
- Missing tooling / config: Scripts that spawn gh need PATH configured
- Unresolved debt: None

### Wish I Had Known
1. Spec said frontend-only but backend Zod schemas also enforced min(8) — always verify both layers
2. gh PATH issue would affect label scripts
3. Nothing else — genuinely trivial issue


## #448 Housekeeping: Clear remaining debt log — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #449

### Metrics
- Files changed: 16 | Tests added/modified: 3 files (error-handler stubs, job error paths, discover fixtures)
- Quality gate runs: 2 (pass on attempt 2 — first failed on return-await lint)
- Fix iterations: 2 (return-await lint violations + auth/discover test fixture updates)
- Context compactions: 0

### Workflow experience
- What went smoothly: Error-handler registry refactor was clean — 21 existing tests validated behavior preservation immediately. Discovery extraction was straightforward with 102 tests confirming no regressions.
- Friction / issues encountered: sendInternalError removal had two hidden blast radius items: auth.test.ts uses its own Fastify app without errorHandlerPlugin, and discover.test.ts mock data lacked Date objects for timestamp fields. Both caused 500s that only surfaced at test runtime.

### Token efficiency
- Highest-token actions: sendInternalError deletion subagent (9 files, ~50 call sites) and self-review exploration
- Avoidable waste: Could have anticipated the return-await lint issue
- Suggestions: When doing bulk try/catch removal, also strip await from bare returns in the same pass

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: scheduleCron/scheduleTimeoutLoop item addressed in this PR. No new debt.

### Wish I'd Known
1. Removing sendInternalError try/catch blocks has hidden test blast radius — route tests with custom app factories need errorHandlerPlugin, partial mock data needs Date objects for mapper functions.
2. Drizzle $inferSelect widens text enum columns to string — shared response types with literal unions need explicit casts at the mapper boundary.
3. return await inside catch blocks is correct per CLAUDE.md, but once the catch is removed, the await becomes a lint violation.

## #437 Architecture review: DIP, ISP, modularity, and DRY fixes — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #447

### Metrics
- Files changed: 15 | Tests added/modified: 6
- Quality gate runs: 2 (pass on attempt 2 — lint fixes needed)
- Fix iterations: 1 (unused vi import, return await in non-try/catch, missing resolveProxyIp in SystemDeps test fixture)
- Context compactions: 0

### Workflow experience
- What went smoothly: Modules 1-6 were clean mechanical refactors. Registry pattern is well-established. CrudSettingsPage migration was 1:1 with zero test changes needed.
- Friction / issues encountered: 5 rounds of spec review before approval (ISP interface split required tracing actual MetadataService call graph). SystemDeps interface extension broke health-check test fixture.

### Token efficiency
- Highest-token actions: Spec review rounds (5 rounds) consumed significant context before implementation started
- Avoidable waste: The ISP split should have been designed by reading the MetadataService call graph first
- Suggestions: For interface splits, trace the call graph in the consuming service FIRST, then define interfaces

### Infrastructure gaps
- Repeated workarounds: none
- Missing tooling / config: none
- Unresolved debt: none introduced

### Wish I'd Known
1. ISP interface splits must follow the actual call graph, not method naming (see isp-split-follows-call-graph.md)
2. Adding a field to SystemDeps interface breaks health-check.service.test.ts createService() fixture (see systemdeps-extension-blast-radius.md)
3. CrudSettingsPage migration is a perfect 1:1 mapping with zero test changes (see crud-settings-page-migration-pattern.md)


## #430 OCP: Settings nav, route, and job auto-registration -- 2026-03-18
**Skill path:** /implement -> /claim -> /plan -> /handoff
**Outcome:** success -- PR #446

### Metrics
- Files changed: 7 | Tests added/modified: 3 new test files, 3 existing updated
- Quality gate runs: 2 (pass on attempt 2 -- first had TypeScript errors from job callback types)
- Fix iterations: 1 (job callback type too narrow for functions returning non-void promises)
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 3-module implementation. All 5809 existing tests passed.
- Friction: vi.mock() hoisting broke App.test.tsx. Job callback types needed widening.

### Token efficiency
- Highest-token actions: Explore subagents for plan and self-review
- Avoidable waste: Elaborate phase had stale ImportListsSettings finding -- cost a spec review round
- Suggestions: Verify subagent defect claims with targeted grep before including in specs

### Infrastructure gaps
- Repeated workarounds: .claude/state/ directory disappearing between steps
- Unresolved debt: scheduleCron/scheduleTimeoutLoop error paths untested (pre-existing)

### Wish I Had Known
1. vi.mock() factories are hoisted above ALL variable declarations
2. Job callback types vary wildly -- use wide return type and cast at registration
3. settingsRegistry (12 schema categories) != settings pages (8 UI routes)

## #431 Code smells: Error utilities, magic numbers, adapter DRY-up — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #445

### Metrics
- Files changed: 45+ | Tests added/modified: 24 new tests across 5 files, 6 test files updated
- Quality gate runs: 2 (pass on attempt 2 — first had lint violations from agent work)
- Fix iterations: 2 (lint violations from agent fetchWithTimeout replacement, pre-existing typecheck failure)
- Context compactions: 0

### Workflow experience
- What went smoothly: Modular TDD approach worked well — each utility was self-contained and could be tested independently before sweeping
- Friction / issues encountered: Agent-based sweeps introduced lint violations (unused vi imports, unnecessary return-await) requiring a fix pass. Pre-existing typecheck failure on main (duplicate enrichmentStatusSchema) initially looked like a regression.

### Token efficiency
- Highest-token actions: Explore subagents for codebase exploration and self-review (each reading 30+ files)
- Avoidable waste: Could have combined the route sweep agents (sendInternalError + getErrorMessage) — ran them separately
- Suggestions: For broad mechanical sweeps, include lint rules in agent prompts to avoid fix-up passes

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: Pre-existing typecheck failure on main should have been caught by CI
- Unresolved debt: error-handler.ts now has 11 instanceof blocks (was 6) — registry pattern needed

### Wish I'd Known
1. AbortSignal.timeout() can't be controlled by vi.useFakeTimers() — agents needed to discover this and adapt test mocking strategies independently
2. Typed error class migrations have a guaranteed blast radius in test mocks — every test that mocks the old Error('message') must be updated to the typed class
3. Pre-existing failures on main should be checked first when verify fails — would have saved a debugging cycle



## #435 SRP: Extract orchestration from QualityGateService — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #441

### Metrics
- Files changed: 8 | Tests added/modified: 67 (25 new orchestrator + 42 restructured service)
- Quality gate runs: 2 (pass on attempt 2 — lint fix for type import)
- Fix iterations: 1 (self-review caught stale SSE status in auto-reject path)
- Context compactions: 0

### Workflow experience
- What went smoothly: The DownloadOrchestrator/ImportOrchestrator pattern was well-established, making the extraction mechanical.
- Friction: Test fixture types needed all schema fields when calling processDownload() directly vs through untyped mockDbChain.

### Token efficiency
- Highest-token actions: Reading full service test file (881 lines), reading routes/index.ts wiring
- Avoidable waste: Could have derived fixture types from schema upfront
- Suggestions: Create shared complete fixture factories per schema type

### Infrastructure gaps
- Missing tooling: No shared complete-fixture factory for DownloadRow/BookRow
- Unresolved debt: jobs/import.ts is a legacy helper that duplicates jobs/index.ts cron registration

### Wish I'd Known
1. Batch loop objects become stale after atomicClaim — SSE must use statusTransition, not download.status
2. Test fixtures need ALL schema fields when called directly (not through mockDbChain)
3. Spec review rounds were expensive but caught real issues — shared orchestration pattern was already established

## #434 SRP: Extract orchestration from DownloadService — 2026-03-18
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #440

### Metrics
- Files changed: 16 | Tests added/modified: 12 (57 new tests, 9 suites restructured)
- Quality gate runs: 2 (pass on attempt 2 — lint complexity fix)
- Fix iterations: 1 (grab() complexity 18→15 via parseDownloadInput + sendToClient extraction)
- Context compactions: 0

### Workflow experience
- What went smoothly: The ImportOrchestrator from #436 was a perfect template — same constructor pattern, same side-effect helper pattern, same test structure
- Friction / issues encountered: Initially forgot to move the book status DB update to the orchestrator (only moved SSE). The E2E test caught it. Also had to fix complexity in grab() even after stripping side effects.

### Token efficiency
- Highest-token actions: The spec review cycle consumed most context — 3 rounds of elaborate → respond-to-spec-review before the spec was approved
- Avoidable waste: The elaboration wrote test plan bullets from assumptions rather than reading source — caused 2 review rounds of corrections
- Suggestions: For extraction specs, always read actual method implementations before writing test plan bullets

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: monitor.ts has parallel orchestration (direct DB writes + SSE + notifications) — separate from DownloadOrchestrator

### Wish I'd Known
1. Book status DB updates are "consequence" side effects that must move with the SSE/notification side effects — they're not core CRUD (ref: orchestrator-book-status-db-update.md)
2. Stripping side effects from a complex method doesn't always fix the complexity lint — protocol parsing and client wiring alone hit 18 branches (ref: grab-complexity-extraction.md)
3. When side effects are independently guarded, each needs its own try/catch (the safe() pattern) — a single outer try/catch stops all remaining effects when one throws (ref: orchestrator-safe-wrapper-pattern.md)


## #436 SRP: Extract orchestration from ImportService — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #439

### Metrics
- Files changed: 15 | Tests added/modified: ~60 (23 new orchestrator, rest restructured)
- Quality gate runs: 3 (pass on attempt 3 — 1st hit max-lines lint, 2nd hit E2E failures from stale callers)
- Fix iterations: 2 (import-steps line limit → extracted to import-side-effects.ts; E2E tests → updated to use orchestrator)
- Context compactions: 0

### Workflow experience
- What went smoothly: The spec was extremely detailed after 4 review rounds — caller matrix, side-effect classification, SSE ownership, test plan. Implementation was mostly mechanical extraction.
- Friction / issues encountered: handleImportFailure mixed core cleanup with side effects — had to split it before the orchestrator could own failure-path dispatch. E2E tests directly called ImportService methods for flows that expect side effects — needed to switch to orchestrator. The 400-line lint limit on import-steps.ts required extracting side-effect functions to a new file.

### Token efficiency
- Highest-token actions: Reading the full import.service.test.ts (1800+ lines) and updating all constructor calls, removing side-effect describe blocks
- Avoidable waste: Could have used a subagent for the import.service.test.ts refactor from the start rather than reading chunks manually first
- Suggestions: For large test file refactors, delegate to a subagent immediately with clear instructions

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory keeps disappearing between steps — mkdir -p needed repeatedly
- Missing tooling / config: None
- Unresolved debt: jobs/import.ts is dead code (not imported anywhere), ImportService.getImportContext duplicates queries that importDownload also runs internally

### Wish I'd Known
1. handleImportFailure had mixed concerns (core cleanup + side effects) — splitting it was a prerequisite not obvious from the spec's "stays in ImportService" framing
2. The 400-line lint limit on import-steps.ts would be hit by the new exports — should have extracted to a separate file from the start
3. E2E tests directly instantiate/call service methods — any extraction refactor needs a blast-radius pass on all E2E test files, not just unit tests

## #428 Upgrade to Node 24 — 2026-03-17
**Skill path:** /implement → /claim (already claimed) → /plan (already planned) → /handoff
**Outcome:** success — PR #438

### Metrics
- Files changed: 8 | Tests added/modified: 1 (5 new assertions in s6-service.test.ts)
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Implementation was already complete (4 commits on branch) — handoff was a straight verification pass. All 293 suites / 5593 tests passed immediately. Self-review and coverage review both clean.
- Friction / issues encountered: `.claude/state/` directory kept disappearing between steps (known recurring issue — mkdir -p needed repeatedly). The claim script rejected because the issue was already in-progress, requiring manual phase marker writes.

### Token efficiency
- Highest-token actions: Self-review subagent (~53k tokens) and coverage review subagent (~35k tokens) for what was essentially a verification-only handoff
- Avoidable waste: Both review subagents were overkill for a version-pin-only change with no application logic. Could skip self-review for infra-only issues.
- Suggestions: Consider a lightweight handoff path for chore/infra issues that skips the behavioral review subagents

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory disappearing (5th consecutive issue with this problem)
- Missing tooling / config: No lightweight handoff path for trivial chore issues
- Unresolved debt: None introduced or discovered

### Wish I'd Known
1. Alpine 3.21 LSIO baseimage doesn't ship Node 24 packages — must COPY binary from builder stage (see `dockerfile-3stage-alpine-node.md`)
2. When an issue is already claimed and partially implemented, `/implement` should detect this and skip to verification rather than re-claiming
3. The `.claude/state/` directory reliability issue has been present for 5+ issues now — needs a persistent fix (tmpdir? gitignored committed dir?)

## #421 Fix test brittleness — hardcoded counts and missing coverage — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #427

### Metrics
- Files changed: 3 | Tests added/modified: 1 new (20 tests), 1 modified
- Quality gate runs: 2 (pass on attempt 1 both times)
- Fix iterations: 0
- Context compactions: 0

### Workflow experience
- What went smoothly: Clean 3-commit implementation — each AC mapped to exactly one commit. Full server test suite (92 files, 2307 tests) confirmed zero regressions for the shared helper change.
- Friction / issues encountered: Branch was created from main while HEAD was on the old #422 branch, causing the coverage review subagent to diff against main and pick up #422 changes. Had to explicitly `git checkout` to the correct branch.

### Token efficiency
- Highest-token actions: Coverage review subagent analyzing 10 files from #422 that weren't relevant
- Avoidable waste: Could have verified HEAD was on the correct branch before launching the coverage subagent
- Suggestions: Add a branch verification step at the start of the coverage review subagent prompt

### Infrastructure gaps
- Repeated workarounds: `.claude/state/` directory disappearing between branch switches — had to `mkdir -p` again
- Missing tooling / config: None
- Unresolved debt: None introduced

### Wish I'd Known
1. `readonly (keyof Services)[]` doesn't enforce exhaustiveness — need `satisfies Record<keyof Services, true>` pattern (see `satisfies-exhaustiveness-guard.md`)
2. Branch creation from `/claim` while on a different branch can leave HEAD detached — always verify with explicit checkout (see `branch-divergence-claim-timing.md`)
3. The coverage review subagent diffs against main, so if the branch includes merged commits from another PR, it'll flag those as untested — scope the diff to branch-only commits

## #422 Code hygiene — extract helpers, typed errors, remove stale patterns — 2026-03-17
**Skill path:** /implement → /claim → /plan → /handoff
**Outcome:** success — PR #426

### Metrics
- Files changed: 13 | Tests added/modified: 7
- Quality gate runs: 3 (pass on attempt 3)
- Fix iterations: 2 (1: lint issues from route simplification + error-handler complexity; 2: typecheck failure from untyped emitSSE + module-scope getTableColumns breaking transitive test mock)
- Context compactions: 0

### Workflow experience
- What went smoothly: AC3 (stale re-exports) was trivial. AC2 typed error pattern was well-established in the codebase — copy/adapt was fast. AC1 extraction hit the line target cleanly.
- Friction / issues encountered: AC4's `getTableColumns` at module scope broke tagging.service.test.ts through a transitive import chain (services/index.ts). Had to make the call lazy. Also needed to fix the tagging test's shallow drizzle-orm mock to use `importOriginal`.

### Token efficiency
- Highest-token actions: Coverage review subagent (exhaustive, read all test files)
- Avoidable waste: Could have anticipated the module-scope issue with getTableColumns before running verify
- Suggestions: When adding module-scope calls to shared utility imports, grep for partial mocks of that module first

### Infrastructure gaps
- Repeated workarounds: None
- Missing tooling / config: None
- Unresolved debt: error-handler.ts complexity growing linearly (6 blocks, eslint-disable); tagging.service.test.ts shallow mock pattern is fragile

### Wish I'd Known
1. `getTableColumns()` at module scope will break any test that partially mocks `drizzle-orm` through transitive imports — use lazy evaluation
2. Removing try/catch from route handlers also requires removing `return await` (eslint `return-await` rule) and the unused `reply` parameter
3. The `emitSSE` helper must preserve the broadcaster's generic type constraint — `string` won't satisfy `SSEEventType`

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
