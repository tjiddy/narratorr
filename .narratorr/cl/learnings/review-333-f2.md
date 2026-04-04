---
scope: [core]
files: [src/server/services/library-scan.service.test.ts]
issue: 333
source: review
date: 2026-04-04
---
When a pure function change affects multiple caller surfaces (scanDirectory and scanSingleBook both call parseFolderStructure), each caller needs its own regression test — not just the function itself. The scanSingleBook direct-folder path was tested for "Author - Title" but not for the new Series–Number–Title pattern. Caller-surface coverage gaps are the most common review finding for parser changes.
