---
scope: [backend, core]
files: [src/server/utils/folder-parsing.ts]
issue: 454
source: review
date: 2026-04-09
---
When extracting metadata from path segments and the extraction empties the segment, every branch must fall back to the original segment — not just the 1-part branch. The 2-part and 3+-part branches in `parseFolderStructure` and `parseFolderStructureRaw` were missing this fallback because the empty-string guard was only in `parseSingleFolder`. The pattern `const titleSegment = cleaned || parts[N]` must be applied everywhere `extractASIN` is called on a path segment.
