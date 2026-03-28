---
scope: [backend]
files: [src/server/services/recycling-bin.service.ts]
issue: 331
date: 2026-03-10
---
When restoring a recycling bin entry that was created for metadata-only recovery (book had no files at deletion time), the restored book must have `path: null` and `status: 'wanted'`, not `path: ''` and `status: 'imported'`. An empty string path is not the same as null — it breaks file operations downstream. Self-review caught this by checking "what happens when originalPath is empty string?" which is a valid state from the moveToRecycleBin code path where files don't exist.
