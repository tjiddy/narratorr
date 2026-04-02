# Workflow Log

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

