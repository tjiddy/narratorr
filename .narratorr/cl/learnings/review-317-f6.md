---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx, src/client/components/settings/IndexerFields.test.tsx]
issue: 317
source: review
date: 2026-04-03
---
Testing minimum-duration overlays requires proving the overlay survives past the API response. A test that waits 3 seconds for eventual disappearance passes whether the minimum is 0ms or 1000ms — it's vacuous for the timing contract. The fix: resolve the API instantly, wait a short real time (200ms), assert overlay is still mounted, then wait for eventual disappearance. `vi.useFakeTimers({ toFake: ['setTimeout'] })` deadlocks when TanStack Query or React internals also use setTimeout; real-time assertions with short delays are more reliable for this pattern.
