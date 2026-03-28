---
scope: [backend, services]
files: [src/server/utils/import-helpers.ts, src/server/utils/import-helpers.test.ts, src/server/services/import.service.test.ts]
issue: 71
source: review
date: 2026-03-24
---
`{narratorLastFirst}` path token must use the position-0 narrator only (matching `{narrator}` and `{authorLastFirst}` behavior). The implementation incorrectly joined ALL narrators last-first with ` & `. The test also asserted the wrong behavior, locking the regression in. When adding multi-entity support to path tokens, verify that tokens like `narratorLastFirst` / `authorLastFirst` follow the "primary entity by position" contract, not a "join all" behavior. Check all sibling test files (import.service.test.ts) for duplicate assertions of the same helper.
