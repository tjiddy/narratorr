---
scope: [core]
files: [src/core/utils/audio-processor.ts, src/core/utils/audio-processor.test.ts]
issue: 424
date: 2026-04-08
---
Testing spawn-based stall timeouts with `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` works cleanly — fake only the timers you need, leave the rest real so EventEmitter-based spawn mocks still fire `process.nextTick`. The `settled` flag pattern prevents double-reject when timeout and close/error race.
