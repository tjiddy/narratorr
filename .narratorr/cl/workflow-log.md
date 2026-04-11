# Workflow Log

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
