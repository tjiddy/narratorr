---
skill: respond-to-pr-review
issue: 434
pr: 440
round: 1
date: 2026-03-18
fixed_findings: [F1, F2]
---

### F1: Orphaned cancel SSE with fabricated book_id:0
**What was caught:** The else branch in cancel() emitted download_status_change with book_id: 0 for downloads without a linked book — an impossible value that could invalidate wrong client cache state.
**Why I missed it:** When writing the cancel orchestration, I added an else branch to "always emit download SSE" without considering that the prior behavior only emitted when bookId existed. Symmetric else branches feel natural but the original code was intentionally asymmetric.
**Prompt fix:** Add to /implement step 4 general rules: "When extracting conditional side effects from a service, preserve the original condition exactly — do not add an else branch that invents default values to fill the alternate path. If the original only fired for linked entities, the orchestrator should only fire for linked entities."

### F2: Incomplete failure-path coverage for fire-and-forget helpers
**What was caught:** 5 of 8 side-effect helpers had no failure-path test, despite each having try/catch or .catch() branches.
**Why I missed it:** Tested failure paths for the first 3 helpers (emitGrabStarted, notifyGrab, recordGrabbedEvent) and assumed the pattern was established — didn't mechanically verify each remaining helper had a corresponding failure test.
**Prompt fix:** Add to /handoff step 4 coverage review subagent prompt: "For every function with a try/catch or .catch() branch, verify there is a direct test that forces the failure path and asserts the error is swallowed + logged. A representative sample is not sufficient — each catch block is a distinct behavior that needs its own test."
