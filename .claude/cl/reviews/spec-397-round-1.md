---
skill: respond-to-spec-review
issue: 397
round: 1
date: 2026-03-15
fixed_findings: [F1, F2, F3]
---

### F1: Incomplete caller/wiring surface in AC5
**What was caught:** AC5 only named 3 direct callers (books routes, search job, rss job) but missed 4 wiring points (Services interface, createServices, system routes manual tasks, jobs/index scheduler registration).
**Why I missed it:** `/elaborate` explored touch points but only traced method-level callers — it didn't trace the service-passing layer (who constructs and passes the service to those callers). The subagent found these files but the gap-fill step didn't promote them into AC.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "For refactors that change a service's public surface, AC must enumerate not just direct method callers but also all wiring points: the Services interface, createServices(), route registration, job registration, and barrel exports. Grep for the service class name across `src/server/` to find them."

### F2: Missing test blast radius section
**What was caught:** Test plan didn't list the 6 test files that would need mock/dependency updates after the service split.
**Why I missed it:** `/elaborate` test plan gap-fill focused on behavioral test cases (what to assert) rather than structural test impact (which test files break when the dependency shape changes). For pure refactors, structural impact IS the primary risk.
**Prompt fix:** Add to `/elaborate` step 4 test plan gap-fill: "For refactors that change constructor or parameter surfaces, add a 'Test file blast radius' section listing every test file that mocks or instantiates the affected service, with the specific change needed (new mock, updated injection, moved tests)."

### F3: Redefined sort types instead of deriving from shared schema
**What was caught:** AC3 would have moved local SortField/SortDirection type unions to the new service, preserving DRY-1 (parallel types) debt when shared schemas already define them.
**Why I missed it:** The elaborate subagent noted the shared schema types but the gap-fill didn't cross-reference local type definitions against shared schemas. This is exactly the DRY-1 architecture check.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For each type/interface being moved or created, check if a canonical version already exists in `src/shared/schemas/` or `src/shared/` and flag DRY-1 if so."
