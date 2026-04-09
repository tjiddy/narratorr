---
scope: [backend, core]
files: [src/server/utils/folder-parsing.ts]
issue: 454
date: 2026-04-09
---
The 2-part branch in `parseFolderStructure` (and `parseFolderStructureRaw`) bypasses `parseSingleFolder` entirely, hardcoding `author=parts[0], title=parts[1]`. Any new extraction logic (like ASIN) must be applied to the title segment in ALL branches independently — it cannot live solely in `parseSingleFolder`. The shared `extractASIN` helper pattern works well for this.
