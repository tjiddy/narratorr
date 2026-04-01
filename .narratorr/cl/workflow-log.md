# Workflow Log

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

