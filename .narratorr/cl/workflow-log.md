# Workflow Log

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
