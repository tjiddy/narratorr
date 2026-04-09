---
scope: [backend]
files: [src/server/routes/library-scan.ts, src/server/utils/folder-parsing.ts]
issue: 446
source: review
date: 2026-04-09
---
When `parseFolderStructure` returns fields like `title`, `author`, `series`, those values are already post-`cleanName()`. Feeding them back into `cleanNameWithTrace()` produces a no-op trace that hides the real transformations. The fix is a `parseFolderStructureRaw()` variant that returns the pre-cleanName values for trace input. Root cause: the spec said "trace from raw" but the implementation didn't account for the parser's internal cleaning.
