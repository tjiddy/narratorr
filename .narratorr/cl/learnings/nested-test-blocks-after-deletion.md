---
scope: [backend, services]
files: [src/server/utils/import-steps.test.ts]
issue: 649
date: 2026-04-18
---
When deleting a `describe` block from a test file, check whether other `describe` blocks were nested inside it. The `runAudioProcessing` describe block contained `checkDiskSpace return type` and `isContentFailure classifier` as nested sub-blocks. Deleting only the parent left orphaned indented blocks with an extra closing `});`, causing a parse error. Always read past the end of the block being deleted to verify no siblings were nested inside.
