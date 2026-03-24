---
scope: [backend, services]
files: [src/server/jobs/search.ts, src/server/services/search-pipeline.ts]
issue: 357
date: 2026-03-13
---
When deduplicating a loop that has a counter (`searched++`) positioned between two sequential operations (search, then grab), extracting both operations into a single function changes where the counter can be incremented. The old code incremented `searched` after `searchAll` but before `grab`, so a grab failure still counted the book as searched. After extracting both into `searchAndGrabForBook`, a grab error throws and the caller can't distinguish "search succeeded but grab failed" from "search itself failed." The test expected `searched=1` on grab failure; after dedup it became `searched=0`. This is an acceptable counter semantics change but needed a test update.
