---
scope: [core, backend]
files: [src/core/utils/chapter-resolver.ts, src/core/utils/chapter-resolver.test.ts]
issue: 546
date: 2026-04-14
---
When downgrading a function from exported to module-private, tests that directly import it will break. If the function is tested indirectly through a public caller (e.g., `parseFilenameForTitle` via `resolveChapterTitle`), remove the direct test block rather than keeping the export just for tests. Check test imports before assuming "tests still pass" after removing an export keyword.
