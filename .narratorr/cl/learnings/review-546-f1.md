---
scope: [core]
files: [src/core/utils/chapter-resolver.ts, src/core/utils/chapter-resolver.test.ts]
issue: 546
source: review
date: 2026-04-14
---
When removing direct tests for a now-private function, verify that ALL branches of that function are still covered through the public API caller. The `parseFilenameForTitle` `Part` prefix stripping branches (disc subfolder path and filename form) had no coverage through `resolveChapterTitle`. The gap: we checked that the function was tested indirectly but didn't enumerate which specific branches were only covered by the removed direct tests.
