---
skill: respond-to-spec-review
issue: 408
round: 2
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4]
---

### F1: Partial-failure contract claims no caller changes but job needs updating
**What was caught:** The Partial Failure Contract said "callers need no changes" while also requiring the discovery job to log warnings — contradictory since the job doesn't currently touch `warnings`.
**Why I missed it:** When fixing round 1's F2 (missing partial-failure contract), I wrote the contract from the route handler's perspective (which does pass through warnings) and generalized to "callers" without checking the job caller separately.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification checklist: "For partial-failure or contract sections, identify ALL callers of the affected function and verify the claim holds for each one individually — not just the primary caller."

### F2: Expiry count returned as `{ expired: 0 }` contradicts RefreshResult-unchanged claim
**What was caught:** Test plan said `{ expired: 0 }` is returned while the spec also said RefreshResult stays unchanged at `{ added, removed, warnings }`.
**Why I missed it:** Round 1 fix for F2 added the partial-failure contract and stated RefreshResult is unchanged, but I didn't re-scan the test plan for stale references to `{ expired: 0 }` that predated the decision.
**Prompt fix:** Add to `/respond-to-spec-review` step 5 (addressing findings): "After resolving any contract/shape decision, search the ENTIRE spec body for all references to the affected fields and update them consistently. Don't just fix the section the finding points to."

### F3: Re-score test plan preserves reason/reasonContext too broadly
**What was caught:** The Re-score on Import test plan said reason/reasonContext are preserved for all import-affected pending suggestions, but AC6 only defines preservation for resurfaced snoozed rows.
**Why I missed it:** When writing the re-score test plan items, I used broader language than AC6 warranted — didn't re-read the AC while writing the test assertions.
**Prompt fix:** Add to `/spec` test plan generation: "For each test plan item that references a specific AC, quote the AC's scope constraint and verify the test item doesn't exceed it. If the test covers a broader case, either narrow it or expand the AC."

### F4: Scope says "backend only" but blast radius includes frontend settings form
**What was caught:** Scope boundaries still said "Backend only" after round 1 expanded the blast radius to include `DiscoverySettingsSection.tsx`.
**Why I missed it:** Expanded the blast radius without cross-checking the scope boundaries section above it.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification: "After any blast radius change, re-read the scope boundaries section and verify consistency."
