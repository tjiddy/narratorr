---
skill: respond-to-spec-review
issue: 411
round: 1
date: 2026-03-16
fixed_findings: [F1, F2, F3, F4]
---

### F1: Route-side type mismatch not included in spec
**What was caught:** The spec fixed the `SettingsService.update()` type but left `PUT /api/settings` still typed as `Partial<AppSettings>`.
**Why I missed it:** Only traced the type mismatch at the service layer. Didn't follow the call chain upward to the route declaration.
**Prompt fix:** Add to `/spec` AC checklist: "For type contract fixes, trace all surfaces that use the affected type (service, route, validators) and ensure the spec covers each one."

### F2: AC4 used "consider" — not testable
**What was caught:** AC4 said "Consider retyping or delegating" — two alternative end states with no way to pass/fail.
**Why I missed it:** Was genuinely unsure which approach was better and deferred the decision to the implementer.
**Prompt fix:** Add to `/spec` AC validation: "Every AC must have exactly one pass/fail outcome. If you're torn between approaches, resolve it now — 'consider X or Y' is never a valid AC."

### F3: "Deep-merge" wording contradicts "no recursive merge" scope boundary
**What was caught:** AC1 said "deep-merges" while scope said no recursive deep-merge.
**Why I missed it:** Used "deep-merge" as a casual synonym for "merge partial fields" without noticing it contradicted the scope boundary.
**Prompt fix:** Add to `/spec` terminology guidance: "Use precise merge terminology: 'flat merge' for category-level spread over flat schemas, 'deep-merge' only for recursive object merging."

### F4: Missing blast-radius note for test helper
**What was caught:** Adding `patch()` to SettingsService requires updating `createMockSettingsService()` in test helpers.
**Why I missed it:** Didn't check test infrastructure for mock factories that enumerate the service's public API.
**Prompt fix:** Add to `/spec` blast-radius checklist: "When adding a public method to a service, check `src/server/__tests__/helpers.ts` for mock factories that enumerate the service API."
