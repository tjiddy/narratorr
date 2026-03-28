---
scope: [backend, services]
files: [src/server/services/library-scan.service.ts]
issue: 104
source: review
date: 2026-03-25
---
Paths persisted to DB/events should always be normalized via path.resolve() before storage. Using raw paths from item.path or buildTargetPath() skips resolution and can store relative or un-normalized paths. Both enrichImportedBook() and processOneImport() stored finalPath directly in the event reason instead of resolve(finalPath). Tests using expect.any(String) for targetPath hide this gap — always assert the exact resolved value in tests.
