---
scope: [backend]
files: [src/server/services/cover-download.ts, src/server/services/cover-download.test.ts]
issue: 560
source: review
date: 2026-04-15
---
When refactoring `contentTypeToExt()` to strip charset suffixes via `.split(';')[0].trim()`, the spec test plan explicitly called out the `image/png; charset=utf-8` edge case but no test was written for it. When introducing a new code branch (even a small one), always add a corresponding test — especially when the spec test plan explicitly names the edge case. The test plan is a checklist, not a suggestion.
