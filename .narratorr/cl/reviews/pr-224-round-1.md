---
skill: respond-to-pr-review
issue: 224
pr: 225
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3, F4]
---
### F1/F2/F3: error prop wiring untested on all 3 migrated selects
**What was caught:** The PR added `error={!!errors.type}` to each migrated select but no test exercised that wiring — the prop could be removed without any test failing.
**Why I missed it:** Self-review and coverage review both rationalized these as "pre-existing" since the type field uses a required enum with a valid default, meaning errors.type can't be triggered through normal user interaction. The coverage review flagged them but I dismissed them as not branch-introduced behavior.
**Prompt fix:** Add to `/handoff` step 2 (self-review): "For every prop added to a shared component in this branch, verify a consumer-level test exercises both the true and false paths of that prop. 'The shared component tests it' is insufficient — the wiring must be proven at each call site."

### F4: formatRelativeDate fallback assertions only rule out negatives
**What was caught:** The 7-day and 8+-day fallback tests used `not.toContain('ago')` instead of asserting the actual absolute-date output.
**Why I missed it:** I wrote the fallback tests first (before the positive relative-time tests) and didn't revisit them after establishing the pattern. The negative assertion felt sufficient but doesn't prove the correct function is called.
**Prompt fix:** Add to testing standards: "Fallback/else branch tests must assert the positive contract (expected output value), not just rule out other branches via negative assertions."
