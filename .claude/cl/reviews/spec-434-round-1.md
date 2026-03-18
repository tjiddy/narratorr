---
skill: respond-to-spec-review
issue: 434
round: 1
date: 2026-03-18
fixed_findings: [F1, F2, F3, F4, F5, F6, F7, F8, F9]
---

### F1: Nonexistent test file reference
**What was caught:** `src/server/routes/download.test.ts` doesn't exist
**Why I missed it:** The `/elaborate` subagent inferred file names from the service name pattern without verifying they exist on disk. No artifact verification step.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For every file path you include in TOUCH POINTS or test impact sections, verify the file exists with glob/ls. Flag inferred-but-unverified paths."

### F2: Incomplete caller surface
**What was caught:** Only route callers listed; 4 non-route callers of grab() and 1 non-route caller of cancel() missed
**Why I missed it:** The elaboration built the caller surface from route registration points only, not from grep of actual method callers. No "grep all callers" step.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "For every service method being extracted, grep for ALL callers across routes/, jobs/, services/, and __tests__/. Build a caller matrix showing each caller's error handling and parameter usage."

### F3: grab_started SSE event dropped
**What was caught:** Spec described generic `download_status_change` but code emits domain-specific `grab_started`
**Why I missed it:** The elaboration's defect vectors section analyzed the SSE code but described it generically. Didn't cross-reference with the SSE event schema to identify domain-specific event types.
**Prompt fix:** Add to `/elaborate` step 3 subagent prompt: "When analyzing SSE emissions, cross-reference every `broadcaster.emit()` call with the SSE event schema to identify the exact event type name, payload shape, and cache invalidation rules."

### F4: Duplicate detection semantics changed
**What was caught:** Test plan said "return existing download" but code throws
**Why I missed it:** Wrote aspirational test plan bullets without reading the current behavior. The elaboration's defect vectors noted the duplicate detection but didn't verify the actual semantics.
**Prompt fix:** Add to `/elaborate` test plan gap-fill: "For refactoring/extraction specs, every test plan bullet MUST match current behavior. Read each method's implementation and write assertions that preserve existing semantics, not desired future semantics."

### F5: updateProgress completion semantics wrong
**What was caught:** Test plan said progress=1.0 shouldn't change status; code sets 'completed'
**Why I missed it:** Same root cause as F4 — wrote test plan from assumptions rather than reading `updateProgress()` source.
**Prompt fix:** Same as F4 — the root fix is the "match current behavior" mandate for extraction specs.

### F6: cancel error propagation semantics changed
**What was caught:** Test plan said cancel should propagate adapter errors; code catches them (best-effort)
**Why I missed it:** Same root cause as F4/F5. The defect vectors section actually identified the cancel error handling correctly but the test plan contradicted it.
**Prompt fix:** Add to `/elaborate` test plan gap-fill: "Cross-check test plan bullets against defect vectors — if the defect analysis found best-effort error handling, the test plan must not assert fail-fast."

### F7: Event metadata silently erased
**What was caught:** Spec only required bookId/downloadId/eventType for events, but source and reason metadata flow through too
**Why I missed it:** The elaboration focused on structural side effects (SSE, notifications) but didn't trace all parameters through the event recording path.
**Prompt fix:** Add to `/elaborate` step 3 subagent deep source analysis: "For every fire-and-forget call being extracted, trace ALL parameters from the original caller through to the final destination. Note any metadata that would be lost if the orchestrator only passes primary identifiers."

### F8: Stale out-of-scope boundary
**What was caught:** Spec left shared orchestration pattern undefined despite #436 already establishing ImportOrchestrator
**Why I missed it:** The elaboration was written before #436 was implemented. Didn't check the current state of related issues in the same series.
**Prompt fix:** Add to `/elaborate` step 3: "For issues in a series (referenced by 'same pattern as #X'), check if any sibling issue has already been implemented. If so, reference the established pattern explicitly rather than leaving it undefined."

### F9: Blast radius underestimated
**What was caught:** 4 test suites listed, actual blast radius is 9
**Why I missed it:** Built test suite list from service + route tests only. Didn't grep for all test files that reference the service or assert the side effects being moved.
**Prompt fix:** Add to `/elaborate` step 3 subagent: "Grep `**/*.test.ts` and `**/*.test.tsx` for all imports of the service being extracted AND all test files that mock/assert the side effects being moved. Include every match in the affected test suites section."
