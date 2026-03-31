---
scope: [backend, core]
files: [src/core/utils/audio-processor.ts, src/core/utils/audio-processor.test.ts]
issue: 257
date: 2026-03-31
---
When migrating from `execFile` (callback-based, promisified) to `spawn` (event-emitter-based), the test mock approach changes significantly. `execFile` mocks simulate callbacks; `spawn` mocks need a `MockChildProcess` class extending `EventEmitter` with `stdout`/`stderr` child emitters, returning it from `mockSpawn`. Use `process.nextTick(() => child.emit('close', code))` for deferred close so callers can attach listeners. Keep `execFile` mock for `ffprobe`/utility calls alongside `spawn` mock for ffmpeg processing.
