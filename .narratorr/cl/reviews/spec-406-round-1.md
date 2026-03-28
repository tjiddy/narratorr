---
skill: respond-to-spec-review
issue: 406
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4, F5, F6]
---

### F1: AC3 dampening formula was "e.g." not a fixed contract
**What was caught:** The multiplier formula was presented as an example, making AC3 non-deterministic.
**Why I missed it:** Treated the formula as self-evident since the shape was clear. Didn't consider that "e.g." means two valid implementations could diverge.
**Prompt fix:** Add to `/spec` AC checklist: "For any AC that references a formula or algorithm, pin the exact formula AND include 3-5 expected input→output pairs so tests can assert specific values. Never use 'e.g.' in a formula AC."

### F2: Settings shallow merge assumption
**What was caught:** Spec assumed `patch()` would deep-merge nested `weightMultipliers`, but it does shallow spread.
**Why I missed it:** Didn't read the `SettingsService.patch()` implementation before specifying the write contract. Assumed generic partial-update semantics.
**Prompt fix:** Add to `/spec` codebase-verification checklist: "When specifying 'store X in settings', read the actual merge semantics of `SettingsService.patch()`/`set()` and specify the exact write method and whether partial or full records are required."

### F3: Concurrent refresh model undefined
**What was caught:** Test plan mentioned concurrent refreshes but spec never defined the concurrency guard or covered all entry points.
**Why I missed it:** Knew the scheduled job used the task registry but didn't trace the manual route's code path, which bypasses it entirely.
**Prompt fix:** Add to `/spec` completeness checklist: "For features triggered by both scheduled jobs and manual routes, verify each entry point's concurrency path and specify the guard mechanism (task registry, mutex, etc.) explicitly in an AC."

### F4: Inspectability surface ambiguous
**What was caught:** Resolved question claimed "inspectable" but spec never tied it to a concrete API surface. Test plan had wishy-washy "if exposed" bullet.
**Why I missed it:** The resolved question felt sufficient without connecting it to an existing endpoint.
**Prompt fix:** Add to `/spec` resolved-questions checklist: "Every benefit claimed in a resolved question must reference the concrete mechanism that delivers it. If no existing surface provides it, add an AC."

### F5: Blast radius of shared schema change not called out
**What was caught:** Adding `weightMultipliers` to discovery settings touches frontend forms and test fixtures beyond the backend scope.
**Why I missed it:** Scoped the issue to backend and didn't trace the settings schema's consumer graph.
**Prompt fix:** Add to `/spec` blast-radius checklist: "When adding fields to shared schemas (settings, DB), trace all consumers across frontend and test fixtures. Add a Blast Radius section noting affected files and whether new fields should be exposed or hidden in the UI."

### F6: Inconsistent terminology (accepted vs added)
**What was caught:** Spec alternated between `accepted` (natural language) and `added` (DB literal).
**Why I missed it:** Used natural language without cross-referencing the schema enum values.
**Prompt fix:** Add to `/spec` terminology checklist: "When referencing DB enum values in ACs and test plans, always use the exact persisted literal. Never introduce natural-language aliases without an explicit glossary entry."