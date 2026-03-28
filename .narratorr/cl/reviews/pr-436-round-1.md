---
skill: respond-to-pr-review
issue: 436
pr: 439
round: 1
date: 2026-03-17
fixed_findings: [F1]
---

### F1: Task-registry import job callback not directly tested
**What was caught:** The `import` task-registry callback in `jobs/index.ts` was changed to call `importOrchestrator.processCompletedDownloads()` but the test only checked registration/scheduling, not execution. A regression to the old `services.import.processCompletedDownloads()` would go undetected.
**Why I missed it:** During the wiring phase, I treated `jobs/index.ts` as a simple one-line change (service target swap) and didn't verify the existing test covered execution. The existing tests were registration-only, which I assumed was sufficient for a callback target change. The handoff coverage review flagged this as pre-existing gap #1 but I didn't classify it as introduced-by-this-PR since the file was only lightly modified.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "When changing a registered callback target (e.g., task registry, event handler), verify the existing tests execute the callback and assert the new target — not just registration. If the test only checks registration, add an execution-level assertion."
