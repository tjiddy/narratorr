---
skill: respond-to-pr-review
issue: 63
pr: 65
round: 1
date: 2026-03-24
fixed_findings: [F1, F2, F3]
---

### F1: import-pipeline statuses lost duplicate-check protection
**What was caught:** Replacing `getInProgressStatuses()` with `getReplacableStatuses()` in the grab() duplicate check silently removed the blocking behavior for `processing_queued` and `importing` downloads.
**Why I missed it:** The spec says "existing duplicate-check logic governs" for pipeline statuses, which I interpreted as "they don't trigger the 409/replacement flow" — I didn't explicitly model that they still need to BLOCK a second grab via the original mechanism. The test I wrote (`proceeds without cancellation...`) confirmed the wrong behavior by mocking an empty query result.
**Prompt fix:** Add to /implement service-level step: "When replacing a query that covers N statuses with a query that covers a subset, explicitly verify the remaining statuses still have their original behavior — either test them directly or add a comment explaining why they're intentionally unblocked."

### F2: book status not reverted when cancel succeeds but replacement grab fails
**What was caught:** The spec's "no transaction: if cancel succeeds but grab fails, user is back to wanted" requirement wasn't implemented — the cancel happened inside `DownloadService.grab()` bypassing the orchestrator's book-status rollback.
**Why I missed it:** I focused on the happy-path contract (cancel → grab succeeds → orchestrator sets to downloading). The failure path (cancel → grab fails → what's the state?) requires explicitly modeling the state at the point of the new grab, not at completion. The CLAUDE.md gotcha "DB update timing: Update DB immediately after first irreversible step" applies directly here.
**Prompt fix:** Add to /implement "For cancel-then-do flows: identify what state the book should be in if the second step fails, and add a test that verifies that state. The state after cancel must be explicitly set, not assumed from the orchestrator's rollback."

### F3: policy-boundary helper has no direct test
**What was caught:** `getReplacableStatuses()` had no test asserting its exact output.
**Why I missed it:** I wrote tests for behaviors that USE the helper but not the helper itself. The helper IS the policy — without a direct test, a regression (e.g., accidentally including `importing`) wouldn't be caught until a higher-level test happens to test that exact boundary.
**Prompt fix:** Add to /plan test stub generation: "For new exported functions that return a fixed list or set (policy boundaries, status sets, category filters), always create a direct test asserting the exact return value AND explicitly asserting items that should NOT be present."
