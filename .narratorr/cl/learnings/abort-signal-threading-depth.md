---
scope: [backend, core]
files: [src/core/utils/audio-processor.ts, src/server/services/merge.service.ts]
issue: 431
date: 2026-04-08
---
Threading AbortSignal through a multi-layer call chain (service → staging → processAudioFiles → mergeFiles → spawnFfmpeg) requires updating every intermediate function signature. The signal must also be passed to internal helpers like `convertFiles` that share the same `spawnFfmpeg` call. Vitest's `toHaveBeenCalledWith` is strict about arg count — adding a trailing `undefined` parameter to existing function calls will break tests that assert exact arg lists. Fix by adding `undefined` to the assertion or using `expect.objectContaining()`.
