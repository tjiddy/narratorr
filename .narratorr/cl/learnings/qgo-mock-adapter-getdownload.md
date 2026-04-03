---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.ts, src/server/services/quality-gate-orchestrator.test.ts]
issue: 318
date: 2026-04-03
---
The quality-gate-orchestrator test suite's `mockAdapter` only had `removeDownload` — adding code that calls `adapter.getDownload()` silently crashed because the method was `undefined`, and the error was swallowed by `processCompletedDownloads`'s try-catch. Always add all interface methods used by new code paths to test mock adapters, even if previous tests didn't need them.
