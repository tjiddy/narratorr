# Workflow Log

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
