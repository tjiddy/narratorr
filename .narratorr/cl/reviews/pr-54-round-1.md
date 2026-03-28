---
skill: respond-to-pr-review
issue: 54
pr: 56
round: 1
date: 2026-03-21
fixed_findings: [F1, F2, F3, F4]
---

### F1: 500 path on single-delete route untested
**What was caught:** `DELETE /api/activity/:id/history` catch block routes errors without "use cancel instead" to 500, but no test exercises this branch.
**Why I missed it:** When writing error path tests, I focused on the two classified cases (400 for guard error, 404 for missing) and forgot the fallthrough 500 applies to any other rejected promise.
**Prompt fix:** Add to /implement step "route tests": "For every route with a try/catch, write a test for EACH response branch — 2xx success, 4xx classified error, AND 5xx fallthrough. Mock the service to reject with an unclassified error for the 5xx test."

### F2: isDeleting prop creates untested loading state
**What was caught:** New `isDeleting` prop disables the delete button and changes its label, but no test exercised `isDeleting={true}`.
**Why I missed it:** The behavioral checklist I applied was: "does the button appear? does it call the right handler?" I didn't apply the same "in-flight UX" checklist I use for `isCancelling`.
**Prompt fix:** Add to /implement component test checklist: "For every new `isLoading`/`isPending`/`isXxx` boolean prop that mutates visible state, add a test with that prop=true asserting disabled status and label swap."

### F3: onSettled modal-close behavior not asserted
**What was caught:** The `ConfirmModal` close via `onSettled` wasn't asserted — existing tests checked toast but not dialog dismissal.
**Why I missed it:** I wrote "confirming calls API + toast" tests and assumed dialog close was implicit. The reviewer correctly identified that removing `onSettled` would leave the modal stuck open while passing existing tests.
**Prompt fix:** Add to /implement: "For any modal confirm flow using `onSettled` to close, add a test asserting `queryByRole('dialog')` becomes null after both success and failure settle."

### F4: Bulk-delete terminal-status filter not proven
**What was caught:** `deleteHistory()` tests only checked the return value, not that the `where` clause actually filtered to terminal statuses.
**Why I missed it:** The test verified observable behavior (count returned), but not the safety property (only terminal rows deleted). This is the spec's key constraint.
**Prompt fix:** Add to /implement service test checklist: "For any delete method with a `where(inArray(...fn()))` filter, assert: (a) the filter function was called, AND (b) the DB chain's `.where()` was invoked. Return-value tests alone don't prove filter correctness."
