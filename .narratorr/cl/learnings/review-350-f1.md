---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 350
source: review
date: 2026-04-04
---
The background import path (`processOneImport`) used `meta?.genres` (the original metadata snapshot) for the existingGenres guard instead of querying current DB state. This meant genres filled between placeholder creation and Audnexus enrichment could be overwritten. The fix was to add a fresh DB query for `books.genres` before calling `applyAudnexusEnrichment`. Root cause: the inline import path (`enrichImportedBook`) gets genres from the `book` object returned by `bookService.create()` which is current, but the background path had no equivalent — the metadata snapshot was incorrectly assumed to be authoritative. During implementation, I should have verified that both caller sites source existingGenres from equivalent authority (live DB state vs stale snapshot).
