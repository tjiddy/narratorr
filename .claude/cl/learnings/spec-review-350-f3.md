---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 350
source: spec-review
date: 2026-03-14
---
Spec review caught a 5th instance of the book status revert pattern in `download.service.ts:403-410` (cancelDownload) that the spec missed. The /elaborate subagent searched the four sites listed in the original findings but didn't independently grep for the full duplication surface (`book.path ? 'imported' : 'wanted'`). When deduplicating a pattern, always grep for the pattern across the entire codebase rather than trusting the issue's listed locations.
