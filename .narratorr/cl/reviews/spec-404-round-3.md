---
skill: respond-to-spec-review
issue: 404
round: 3
date: 2026-03-17
fixed_findings: [F5]
---

### F5: Fractional-position worked example still wrong after two fix rounds
**What was caught:** The spec claimed `[1.5, 2.5]` → `missingPositions: [2, 3.5]` but the actual loop output is `[3.5]` only, because the loop counter starts at 1.5 and increments by 1, never hitting integer 2.
**Why I missed it:** I correctly identified the `Number.isInteger(i)` filter in round 2 but didn't trace the loop initialization value. I assumed the loop would visit integer 2 because it's "between" 1.5 and 2.5, without actually stepping through `i = Math.min(1.5, 2.5) = 1.5; i += 1 → 2.5`. This is the third round on the same conceptual issue — each round fixed the prose but carried forward the same wrong example.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 ("Verify fixes before writing"): "For worked examples involving loops, trace the actual loop variable values (init → condition → increment → each iteration body) before asserting outputs. Do not reason about filter conditions in isolation from the loop counter's actual trajectory."
