---
scope: [backend]
files: [src/server/services/merge.service.test.ts]
issue: 368
date: 2026-04-06
---
Testing fire-and-forget queue patterns (enqueueMerge starts a merge asynchronously, returns immediately) requires controlling when the background work completes. Use a deferred promise pattern: `processAudioFiles` mock returns a promise that resolves when a captured `resolve` function is called. Then `await new Promise(resolve => setTimeout(resolve, 50))` to let microtasks drain after resolving. Without this pattern, the test returns before the queue drains and assertions on post-drain state fail intermittently.
