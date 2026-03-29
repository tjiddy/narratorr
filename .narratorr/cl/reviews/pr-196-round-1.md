---
skill: respond-to-pr-review
issue: 196
pr: 203
round: 1
date: 2026-03-29
fixed_findings: [F1, F2]
---

### F1: Fractional gap/continuation matching uses exact equality downstream
**What was caught:** `discovery-candidates.ts` still used `===` and `Array.includes()` for comparing positions after `computeSeriesGaps` was updated with floating-point tolerance.
**Why I missed it:** The self-review checked that tolerance existed in `computeSeriesGaps` but didn't trace the data flow through consumers. The note about "acceptable in practice for Audible book positions" dismissed the theoretical risk without testing it.
**Prompt fix:** Add to `/handoff` step 2 self-review prompt: "When a PR introduces tolerance/rounding in a producer, grep all consumers of the produced values for exact equality comparisons (`===`, `.includes()`) that should use tolerance-aware matching. Each comparison is a potential regression site."

### F2: Missing fractional candidate integration tests
**What was caught:** Service-level tests only covered integer continuation/gap paths. No test drove `generateCandidates()` with fractional positions through `querySeriesCandidates()` and `scoreCandidate()`.
**Why I missed it:** Coverage review subagent noted the gap but classified it as "practical impact minimal" rather than a blocking issue. The spec AC7 required "integration level" coverage for fractional positions, which was only partially met.
**Prompt fix:** Add to `/handoff` step 4 coverage review prompt: "When a bug fix modifies both a computation function and its consumers, verify there is at least one integration test that exercises the bug-triggering input through the full consumer pipeline — not just the computation in isolation."
