---
scope: [backend]
files: [src/server/jobs/index.ts, src/server/jobs/index.test.ts]
issue: 547
date: 2026-04-14
---
`TaskRegistry.executeTracked()` has no internal catch — errors propagate to the caller. When adding per-sub-task try/catch inside a housekeeping callback, the callback itself no longer throws, so tests no longer need `.catch(() => {})` after `executeTracked`. The old pinned test pattern (`await executeTracked('housekeeping').catch(() => {})`) was only needed because the callback lacked isolation. After isolation, `executeTracked` resolves normally even when sub-tasks fail internally.
