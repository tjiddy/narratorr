---
skill: respond-to-pr-review
issue: 366
pr: 401
round: 2
date: 2026-03-16
fixed_findings: [F9]
---

### F9: Timeout-loop test doesn't prove intervalHours conversion
**What was caught:** The F8 fix test only asserted `settings.get('discovery')` was called, not that the result was multiplied by 60.
**Why I missed it:** I tested the integration point (settings category called) but not the transformation (hours → minutes). The `vi.waitFor` + `toHaveBeenCalledWith` pattern felt like enough, but it only proves the input, not the output math.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fix validation: "When a finding says 'test must assert value X,' the fix must capture the actual computed value and assert it — not just assert the input that feeds the computation. If the test would still pass with the computation removed, the assertion is too weak."
