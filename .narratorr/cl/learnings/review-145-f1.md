---
scope: [scope/backend]
files: [src/shared/schemas/settings.test.ts, src/shared/schemas/settings/library.ts]
issue: 145
source: review
date: 2026-03-26
---
When adding `.trim()` to sibling fields (`folderFormat` and `fileFormat`), tests proved the first field's whitespace-only rejection with the exact error message, but not the second. The fix for `folderFormat` got an explicit `'Folder format is required'` assertion; `fileFormat` only got `success === false`. Since both the old refine failure and the new min(1) failure both produce `success === false`, the test didn't distinguish between them — removing `.trim()` from `fileFormat` would still pass the existing suite.

Also missing: trim-normalization tests for both template fields (showing spaces are stripped before refine sees the value). Only `path` got a trim-produces-correct-output test.

What would have prevented it: when adding `.trim()` to multiple sibling fields in the same schema, the test plan must include (a) exact error-message assertions for *each* field, not just the first, and (b) a single test that trims all affected sibling fields together and asserts all normalized outputs.
