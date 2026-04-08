---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 426
date: 2026-04-08
---
In `cleanName()`, the order of stripping operations matters: series markers must be stripped before deduplication (so "Title, Book 01 – Title" can match), and empty brackets must be removed before narrator parenthetical stripping (so "(MP3)" → "()" → removed, not matched as a narrator name). Year/codec removal happens in `normalizeFolderName()` before narrator stripping to prevent false positives.
