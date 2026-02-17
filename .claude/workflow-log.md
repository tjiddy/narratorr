# Workflow Log

## #131 Increase test coverage: error paths, edge cases — 2026-02-16
**Skill path:** /implement → /claim (with elaborate subagent) → /handoff
**Outcome:** success — PR #134

### Workflow experience
- What went smoothly: Parallelized agents for core/server/frontend work well. Background agents for services and jobs ran concurrently while route tests were written in main context.
- Friction / issues encountered: Background agents used `mockDbChain` spread pattern `{...mockDbChain(), then: reject}` which doesn't work — chain methods return internal object, bypassing custom `.then`. Fixed with `mockImplementation(() => { throw ... })`. Also frontend agent produced 3 typecheck errors that needed manual fix.

### Token efficiency
- Highest-token actions: Reading all 35+ test files and their corresponding source files
- Avoidable waste: Background agents writing broken mock patterns that needed manual fixing
- Suggestions: Add a `mockRejectionChain(error)` helper to test helpers to avoid this pattern bug

## #122 Enrich directory-scanned books with audio file metadata — 2026-02-16
**Skill path:** /implement → /claim (with elaborate subagent) → /handoff
**Outcome:** success — PR #123

### Workflow experience
- What went smoothly: Clean extraction refactor — moved `enrichFromAudioFiles` from ImportService into shared utility, wired into LibraryScanService, expanded response types. Issue was pre-elaborated before `/implement`, so claim validation was fast. 16 new tests, all quality gates passed after one fix iteration.
- Friction / issues encountered: Test mock for `enrichBookFromAudio` accumulated calls across tests (missing `vi.clearAllMocks()` in nested `beforeEach`). Windows path separators in `join()` broke cover art path assertions — switched to `stringContaining`. TypeScript caught optional vs required field mismatch in `ImportResult` → `useState` initializer.

### Token efficiency
- Highest-token actions: Reading existing ImportService and LibraryScanService to understand enrichment pattern
- Avoidable waste: Could have added `vi.clearAllMocks()` to the nested `beforeEach` from the start — this is a recurring pattern
- Suggestions: When mocking a module-level function in a nested describe block, always clear mocks in that block's `beforeEach`

## #63 Prowlarr integration as unified indexer proxy — 2026-02-16
**Skill path:** /implement → /claim (with elaborate subagent) → /handoff
**Outcome:** success — PR #120

### Workflow experience
- What went smoothly: Large feature (core client, sync service, 5 routes, full UI component, 30 tests) landed in a single pass. Preview-before-apply pattern kept the sync logic clean. Design pass caught good refinements — inline test button, segmented sync mode control, staggered row animations.
- Friction / issues encountered: Adding `source`/`sourceIndexerId` columns to indexers schema broke existing `indexer.service.test.ts` mock (missing new fields). Initially used dynamic imports for the settings table in sync service — unnecessary complexity, cleaned up to static import. Git push auth failed on first attempt (known quirk, retry worked).

### Token efficiency
- Highest-token actions: Validation subagent codebase exploration, frontend design pass review
- Avoidable waste: Could have added the new schema fields to the existing test mock proactively instead of discovering it at typecheck
- Suggestions: When adding columns to a schema table, immediately grep for test mocks of that table's rows and update them

## #64 Protocol badges in search and activity — 2026-02-16
**Skill path:** /implement → /claim (with elaborate subagent) → /handoff
**Outcome:** success — PR #116

### Workflow experience
- What went smoothly: Tiny frontend-only feature — new ProtocolBadge component + 2 single-line wiring changes. All quality gates passed first try. Subagent correctly filled in missing AC/test plan/impl detail on a bare issue.
- Friction / issues encountered: Git push auth failed on first attempt (known quirk, retry worked). No code-level friction.

### Token efficiency
- Highest-token actions: Validation subagent reading context + exploring codebase
- Avoidable waste: None — clean pass
- Suggestions: For small UI-only features, subagent could skip deep codebase exploration

## #87 Metadata provider rate limiting — 2026-02-16
**Skill path:** /implement → /claim (with elaborate subagent) → /handoff
**Outcome:** success — PR #115

### Workflow experience
- What went smoothly: Clean implementation — RateLimitError, adapter 429 detection, and withThrottle() DRY helper all landed in single pass. Enrichment job batch-break pattern was straightforward. 15 new tests all passed after 2 fix iterations.
- Friction / issues encountered: Adapter catch-all blocks (`catch { return null }`) swallowed the RateLimitError — needed to add `if (error instanceof RateLimitError) throw error` re-throws. Mock call counts leaked between tests — fixed with `vi.clearAllMocks()`. Git push auth failed on first attempt (known quirk, retry worked).

### Token efficiency
- Highest-token actions: Validation subagent codebase exploration, reading all provider/service/job files
- Avoidable waste: Could have anticipated catch-block swallowing — two adapter files needed re-editing
- Suggestions: When adding errors that must propagate through catch blocks, always check for catch-all patterns

