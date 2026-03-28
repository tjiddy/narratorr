---
skill: respond-to-spec-review
issue: 435
round: 3
date: 2026-03-18
fixed_findings: [F8, F9, F10, F11]
---

### F8: Cron caller still pointed at legacy helper
**What was caught:** Caller matrix said `jobs/import.ts:11` but live registration is `jobs/index.ts:33`.
**Why I missed it:** Round 1 fix corrected the caller matrix concept but copied the wrong file path from the subagent's report without verifying which was the actual registration entry point vs. a called helper.
**Prompt fix:** Add to `/respond-to-spec-review` step 6 verification: "For every file path in the caller matrix, verify it is the live registration/entry point (not a transitive helper) by checking where cron tasks are actually registered."

### F9: No batch-input seam for orchestrator loop
**What was caught:** The orchestrator `processCompletedDownloads()` had no defined source for its completed-download list — unlike `ImportOrchestrator` which pulls from `ImportService.getEligibleDownloads()`.
**Why I missed it:** Focused on extracting side effects and the decision logic, but didn't think about the query at the top of `processCompletedDownloads()` as a separate concern needing its own API surface entry. The existing pattern (`getEligibleDownloads`) was documented in the orchestration pattern section but not applied to the QGS API table.
**Prompt fix:** Add to `/elaborate` step 4 post-extraction API surface: "For any batch operation being moved to an orchestrator, define the batch-input method explicitly in the service API table (e.g., `getCompletedDownloads()` mirrors `getEligibleDownloads()`)."

### F10: Null scan result test in wrong layer
**What was caught:** Probe failure tests were under QGS service tests but scanning moves to orchestrator.
**Why I missed it:** Carried over test plan items from round 1 without re-checking layer boundaries after moving scanning to orchestrator.
**Prompt fix:** Add to `/respond-to-spec-review` step 5: "After updating layer boundaries, re-audit every test plan item to ensure it's assigned to the correct layer."

### F11: Blast radius still missing jobs/index.test.ts
**What was caught:** `jobs/index.test.ts` asserts quality gate cron wiring but wasn't in blast radius.
**Why I missed it:** Round 1 F7 fix added `jobs/import.test.ts` but not the parallel `jobs/index.test.ts` which also asserts the same call.
**Prompt fix:** Already covered by F7's prompt fix (grep service name across entire src/ tree). The issue was not applying the fix thoroughly.
