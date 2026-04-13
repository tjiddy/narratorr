---
scope: [backend]
files: [src/server/services/metadata.service.ts]
issue: 523
date: 2026-04-13
---
When adding filtering to a new code path that already exists elsewhere in the same service, extract a shared private method rather than duplicating the filter logic. In this case, `filterAuthorBooks()` already had language filtering but also did reject-word filtering — the language portion was extracted into `filterBooksByLanguage()` so `search()` could reuse it without pulling in reject-word logic. This kept the file under the 350-line threshold and avoided DRY violations.
