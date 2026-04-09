---
scope: [frontend]
files: [src/core/utils/parse.ts]
issue: 455
date: 2026-04-09
---
`formatBytes()` uses binary units (1024-based), so 500000000 bytes = 476.84 MB, not 500 MB. Test assertions for formatted byte values must use the actual `formatBytes()` output, not human-estimated decimal values. Read the formatter source before writing byte-related test assertions.
