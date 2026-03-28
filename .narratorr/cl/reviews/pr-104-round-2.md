---
skill: respond-to-pr-review
issue: 104
pr: 109
round: 2
date: 2026-03-25
fixed_findings: [F1, F2, F3, F4, F5]
---

### F1: importSingleBook() doesn't record import_failed for bookService.create() failures
**What was caught:** The failure event was only recorded after enrichImportedBook() failed, not when bookService.create() failed first. The bookId wasn't available yet, but the DB schema allowed NULL bookId in book_events.
**Why I missed it:** Spec AC said "record import_failed on failure" — I interpreted this as post-book-creation failure only. Didn't analyze all failure points in the call chain. Also didn't check whether CreateEventInput.bookId was flexible enough to support null.
**Prompt fix:** Add to /plan step: "For each event-recording AC, enumerate ALL failure points in the method (not just the last one). Check whether the FK field in CreateEventInput supports null before concluding a pre-creation event is impossible."

### F2: targetPath in events not resolved via path.resolve()
**What was caught:** finalPath was stored directly in event reason without resolve(), potentially storing non-normalized paths.
**Why I missed it:** Focused on getting the right value into the event, not on normalizing it. Didn't apply the general rule "normalize paths before storage" to event payloads specifically.
**Prompt fix:** Add to CLAUDE.md Gotchas or /implement checklist: "Any path value persisted to DB or event payloads must be wrapped in resolve() before storage."

### F3: No fire-and-forget isolation test for importSingleBook() success
**What was caught:** The fire-and-forget .catch() handler on the success event needed a dedicated test confirming the method still resolves when event creation rejects.
**Why I missed it:** Wrote tests for the rejection case (import failure + event) and the success case (event succeeds), but missed the cross-combination (success + event rejects).
**Prompt fix:** Add to /plan testing standards: "For every .catch() fire-and-forget handler, write tests for: (a) primary succeeds, event rejects — primary result unchanged; (b) primary fails, event rejects — original error still thrown; (c) background failure, event rejects — status update still completes."

### F4: No test for double-reject (import + event creation both reject)
**What was caught:** Same gap as F3 — missing the case where enrichImportedBook throws AND eventHistory.create also rejects.
**Why I missed it:** Same root cause as F3.
**Prompt fix:** Same as F3 prompt fix above.

### F5: No test for background failure when eventHistory.create rejects
**What was caught:** The processImportsInBackground catch block has its own .catch() for event recording, with no test for the case where that also rejects.
**Why I missed it:** The existing test "event recording failure does not break the background import flow" tested the SUCCESS path (event create rejects but import succeeds). The FAILURE path (both enrichment and event create reject) had no test.
**Prompt fix:** Same as F3 prompt fix above.
