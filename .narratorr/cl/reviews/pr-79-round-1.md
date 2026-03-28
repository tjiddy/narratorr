---
skill: respond-to-pr-review
issue: 79
pr: 84
round: 1
date: 2026-03-24
fixed_findings: [F1, F2]
---

### F1: multi-author metadata dropped when parsed folder author exists
**What was caught:** `buildBookCreatePayload()` used `item.authorName ? [single] : meta.authors`, making any parsed folder author an absolute override that silently dropped co-authors from metadata.
**Why I missed it:** The test AC for issue #79 said "passes meta.authors array when available" and my tests only exercised the metadata-only path (no item.authorName) and the fallback path (no meta.authors). I didn't write a test for the intersection — both present with metadata being a superset. The "preserves user-provided values" test in the main describe block gave false confidence about the precedence logic.
**Prompt fix:** Add to `/plan` step 3 (test stubs): "For any AC of the form 'prefer X when available', add an explicit test where BOTH the primary value and the fallback value are present — assert which wins. Single-presence tests don't cover the intersection."

### F2: BookService.create() not atomic after helper extraction
**What was caught:** Extracting `syncAuthors`/`syncNarrators` into shared helpers left `create()` with a partial-write window: book row persists if junction sync fails.
**Why I missed it:** I focused on the happy path and the race-condition retry test. The existing test for sync failure only asserted the rejection, not that the DB was left clean. I didn't apply atomicity analysis when re-ordering the insert steps during the helper extraction.
**Prompt fix:** Add to CLAUDE.md gotchas: "**Multi-step insert atomicity:** When a function inserts to table A then writes to table B, explicitly choose (a) transaction-wrapped or (b) compensating delete on failure. The test must verify the orphan is cleaned up — asserting the rejection alone doesn't prove the DB is clean."
