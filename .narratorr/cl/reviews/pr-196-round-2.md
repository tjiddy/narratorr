---
skill: respond-to-pr-review
issue: 196
pr: 203
round: 2
date: 2026-03-29
fixed_findings: [F3]
---

### F3: Missing reasonContext assertion for tolerance-aware reason-text branch
**What was caught:** The new `nearlyEqual(pos, gap.nextPosition)` ternary in reason-text formatting had no direct test assertion, so inverting or deleting it wouldn't fail the suite.
**Why I missed it:** When writing integration tests for F2, I focused on the primary behavioral assertions (score and reason) and didn't trace all output fields affected by the changed code path. The `reasonContext` field was a secondary output that I treated as implicitly covered.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 fix completeness check: "For each fixed branch/conditional, verify that at least one test assertion would fail if the branch were inverted or deleted. If the changed code produces multiple output fields, assert ALL fields touched by the change — not just the primary ones."
