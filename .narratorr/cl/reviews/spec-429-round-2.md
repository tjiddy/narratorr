---
skill: respond-to-spec-review
issue: 429
round: 2
date: 2026-03-17
fixed_findings: [F1, F2, F3, F4]
---

### F1: AC1 overpromises adapter extensibility
**What was caught:** AC1 said "ONE file + ONE registry entry" but core ADAPTER_FACTORIES still need entries.
**Why I missed it:** The elaboration focused on validating the dual-enum pattern (which is real) but didn't trace the full "add a new adapter type" workflow end-to-end through all layers. The scope boundaries correctly excluded #430 auto-registration, but the AC was written against the aspiration, not the scoped deliverable.
**Prompt fix:** Add to `/elaborate` step 4 gap-fill: "For each AC, trace the concrete file edits a developer would make to exercise the promised outcome. If any required edit falls outside the declared scope, narrow the AC to match."

### F2: AC2/AC3 overstate notification-event centralization
**What was caught:** ACs promised "ONE registry entry" and "zero duplicates across all layers" but per-adapter EVENT_TITLES maps are explicitly out of scope.
**Why I missed it:** Scope boundaries were written correctly (per-adapter maps out of scope), but ACs were drafted independently without cross-referencing. Classic consistency gap between two sections of the same spec.
**Prompt fix:** Add to `/elaborate` step 2 parse completeness: "Cross-check each AC against scope boundaries — if a scope boundary excludes something, no AC should promise it."

### F3: No canonical location for notification-event registry
**What was caught:** Spec proposed moving formatEventMessage to registry pattern but didn't specify which module owns it.
**Why I missed it:** The elaboration identified the triple-definition problem and proposed consolidation, but stopped at "replace switch with registry lookup" without specifying the concrete file location and import direction. Design decisions about cross-layer moves need explicit artifact-to-file mapping.
**Prompt fix:** Add to `/elaborate` step 4: "When a refactor moves artifacts between layers (core ↔ shared ↔ server), add a Design Decision section with: (1) artifact-to-file mapping table (current → post-refactor), (2) allowed import direction, (3) what stays in the original location."

### F4: Blast radius undercounts notifier adapter test suites
**What was caught:** 9 notifier adapter test files were missing from the blast radius.
**Why I missed it:** The Explore subagent found the per-adapter EVENT_TITLES maps but the blast radius was assembled from a grep for schema imports, not from co-located test files of affected source files.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For every source file identified as affected, also check for its co-located test file (*.test.ts/tsx) and include it in the blast radius."
