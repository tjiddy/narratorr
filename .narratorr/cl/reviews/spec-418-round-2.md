---
skill: respond-to-spec-review
issue: 418
round: 2
date: 2026-03-17
fixed_findings: [F6, F7]
---

### F6: AC3 still claims no hardcoded reason literals despite intentional service-layer carveout
**What was caught:** AC3 said "no hardcoded reason string literals remain in production code" but the spec explicitly keeps `getStrengthForReason` switch cases and `SIGNAL_WEIGHTS` reason-keyed entries in place.
**Why I missed it:** When narrowing the headline goal (F3 fix from round 1), I updated the description and added a note about service-layer logic but didn't propagate the narrowing into AC3's exact wording. The AC was copy-edited around the note rather than rewritten to match the new scope.
**Prompt fix:** Add to `/respond-to-spec-review` step 5 (Address each finding): "After fixing a finding that narrows scope or goals, grep all ACs for language that contradicts the narrowed scope. ACs must be satisfiable given stated scope boundaries."

### F7: Settings test plan introduced behavior change in a pure-refactor spec
**What was caught:** Test plan said `weightMultipliersSchema` should "reject unknown keys" but current `z.object()` strips them, making this a behavior change.
**Why I missed it:** When adding settings derivation coverage (F2 fix from round 1), I wrote test expectations based on what seemed correct rather than verifying the current schema's actual behavior with unknown keys. The "pure refactor" framing should have been a red flag to check existing behavior first.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 (Verify fixes): "For test plan additions on newly-in-scope surfaces, verify current behavior (parse/call the actual code if needed) before writing expected outcomes. Pure-refactor specs must not introduce behavioral assertions that differ from current behavior."
