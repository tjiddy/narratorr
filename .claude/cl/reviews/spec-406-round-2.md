---
skill: respond-to-spec-review
issue: 406
round: 2
date: 2026-03-17
fixed_findings: [F7, F8, F9]
---

### F7: Boundary case expects impossible floor outcome
**What was caught:** The boundary test said "all weights at floor" but the formula can only produce 0.60 at ratio 1.0, never 0.25.
**Why I missed it:** When fixing F1 (locking down the formula), I updated AC3 and the multiplier calculation test section but didn't re-read the boundary cases section to check consistency with the new numbers.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification checklist: "After fixing a formula or contract finding, search the entire spec for all references to that formula's outputs (floor, ceiling, expected values) and verify each one matches the updated contract."

### F8: Schema default `{}` contradicts Record type and inspectability
**What was caught:** Blast Radius said `.default({})` but AC4 declared `Record<SuggestionReason, number>` and the inspectability story needed a full record from `GET /api/settings`.
**Why I missed it:** When adding the blast radius section (fixing F5), I picked the simplest Zod default without checking whether it satisfied the type contract and API consumer expectations I'd already defined in AC4.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification checklist: "For schema/default changes, verify the default value satisfies: 1) the declared TypeScript type, 2) every API consumer's expected response shape, 3) any inspectability or observability claims in the spec."

### F9: Lingering `accepts` instead of `added`
**What was caught:** One boundary case bullet still used "accepts all others" after the F6 terminology cleanup.
**Why I missed it:** Did a targeted replacement of `accepted` → `added` in the AC section but didn't search the full spec body for related word forms (`accepts`).
**Prompt fix:** Add to `/respond-to-spec-review` step 5 for terminology fixes: "Search the entire spec for all morphological variants of the old term (e.g., for `accepted` also search `accepts`, `accepting`) to catch all instances."
