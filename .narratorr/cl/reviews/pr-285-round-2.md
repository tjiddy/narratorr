---
skill: respond-to-pr-review
issue: 285
pr: 346
round: 2
date: 2026-03-12
fixed_findings: [F1, F2]
---

### F1: updateImportListSchema missing provider validation
**What was caught:** The round 1 fix added `validateRequiredSettings` to `createImportListSchema` and `previewImportListSchema` but missed `updateImportListSchema`, leaving PUT requests unvalidated.
**Why I missed it:** When fixing round 1's F2, I focused on the create and preview paths because those were explicitly named. I didn't systematically check all schema variants that accept `settings`.
**Prompt fix:** Add to `/respond-to-pr-review` step 3 (addressing findings): "When fixing validation gaps, grep for all schema variants of the same entity (create/update/patch/form) and apply the fix to every variant that accepts the validated fields."

### F2: New route added without integration tests
**What was caught:** The ABS library-fetch route (`/api/import-lists/abs/libraries`) was added in a fix commit but had no route-level integration tests.
**Why I missed it:** Fix commits during `/respond-to-pr-review` focused on addressing the specific finding (F1 — provider-specific UI controls) without treating the new route as a first-class addition requiring its own test coverage.
**Prompt fix:** Add to `/respond-to-pr-review` step 3: "When a fix introduces a new route endpoint, add route-level integration tests (Fastify inject) covering success, validation error, and upstream failure paths — even if frontend tests already mock the API call."
