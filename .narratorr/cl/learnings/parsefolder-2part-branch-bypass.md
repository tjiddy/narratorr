---
scope: [core]
files: [src/server/services/library-scan.service.ts]
issue: 333
date: 2026-04-04
---
`parseFolderStructure` has separate control flow branches for 1-part, 2-part, and 3+ part paths. The 2-part branch hardcodes `author=parts[0], title=parts[1]` and never calls `parseSingleFolder`. When fixing folder parsing bugs, check which branch actually handles the failing input — modifying only `parseSingleFolder` won't fix 2-part-path issues. The spec review correctly caught this misalignment.
