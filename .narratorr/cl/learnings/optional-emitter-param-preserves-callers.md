---
scope: [backend]
files: [src/server/utils/download-side-effects.ts, src/server/services/download-orchestrator.ts, src/server/jobs/monitor.ts]
issue: 655
date: 2026-04-20
---
When extending a shared emitter/helper signature with a new field, making the new parameter optional with a sensible default (`speed?: number | null`, default `null`) lets existing callers without context keep working while new callers pass the real value. Cheaper than threading the new field through every caller's code path just to satisfy typecheck. The test pattern that proves this works: assert the emitter payload stays the same for the old caller while the new caller's payload carries the propagated value — and that `0` is preserved rather than coerced to `null` (falsy-coercion gotcha).
