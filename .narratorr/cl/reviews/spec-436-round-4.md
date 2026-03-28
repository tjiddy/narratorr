---
skill: respond-to-spec-review
issue: 436
round: 4
date: 2026-03-17
fixed_findings: [F1]
---

### F1: Approve-path concurrency branch missing from caller matrix
**What was caught:** The caller matrix showed the approve route calling `orchestrator.importDownload(id)` directly, omitting the existing `tryAcquireSlot()` / `setProcessingQueued()` / `releaseSlot()` concurrency branch that gates whether the import fires immediately or queues.
**Why I missed it:** When updating the caller matrix in round 2 to add entry points, I focused on which object receives the import call (orchestrator vs service) and treated the route handler as a thin pass-through. I did not trace the full handler logic to capture the concurrency gate that wraps the import call. The AC already said concurrency stays on ImportService, but the caller matrix contradicted that by showing a direct call without the gate.
**Prompt fix:** Add to `/spec` caller matrix checklist: "For each caller, read the full function body (not just the import call) and list every service method invoked in sequence. Caller matrix entries must show the complete call flow including gates, branches, and cleanup, not just the primary operation."
