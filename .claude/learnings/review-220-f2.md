---
scope: [scope/core]
files: [packages/core/src/download-clients/qbittorrent.test.ts, packages/core/src/download-clients/sabnzbd.test.ts, packages/core/src/download-clients/nzbget.test.ts]
issue: 220
source: review
date: 2026-02-24
---
Reviewer caught missing timeout tests for getCategories() in all three adapters that support categories. The existing tests covered success/empty/auth/network/malformed but not timeout. Pattern for timeout tests with MSW: use `delay('infinite')` + `vi.useFakeTimers()` + attach assertion before advancing timers to avoid unhandled rejection (`const assertion = expect(promise).rejects.toThrow()` before `await vi.advanceTimersByTimeAsync()`).
