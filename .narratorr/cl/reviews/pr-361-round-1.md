---
skill: respond-to-pr-review
issue: 361
pr: 402
round: 1
date: 2026-03-16
fixed_findings: [F1]
---

### F1: Failure notification uses book.title instead of download.title
**What was caught:** The extracted `handleImportFailure()` uses `book.title` in the `on_failure` notification payload, but the original code used `download.title`. These differ when the download name (torrent release) doesn't match the clean book metadata title.
**Why I missed it:** During extraction, I focused on what data the function *needed* (book id, book title, book path) and collapsed `download.title` into `book.title` because both seemed equivalent. The self-review and coverage review agents both checked that the notification was "called with on_failure event" but didn't compare the exact payload field source against the original.
**Prompt fix:** Add to `/implement` step 4d (sibling enumeration): "For each extracted function, diff every field in the original inline code against the extracted version's parameter sources. Verify no field was silently substituted with a same-named-but-different-source value (e.g., `download.title` vs `book.title`, `download.id` vs `book.id`)."
