---
scope: [backend]
files: [src/server/jobs/monitor.ts, src/server/jobs/monitor.test.ts]
issue: 373
source: review
date: 2026-04-06
---
When adding a new parameter to an existing function (isCompletionTransition to resolveOutputPath), the new parameter creates a matrix of behavior combinations with existing code paths. The test for "empty savePath preserves outputPath" covered one early-return case, but didn't cover the remote-path-mapping-failure case combined with the completion transition flag. Each existing behavior branch needs re-testing with the new parameter's true/false values to ensure the matrix is complete.
