---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 255
date: 2026-03-31
---
When extracting shared normalization from `cleanName`/`extractYear`, the year-stripping regexes in `cleanName` leave trailing whitespace that was previously cleaned by the final `trim()` in the original monolithic chain. After extraction, a `.trim()` must follow the year-stripping regexes — `normalizeFolderName()` trims, but `cleanName` appends more regex steps after calling it.
