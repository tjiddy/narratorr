---
scope: [infra]
files: [e2e/tests/critical-path/search-grab-import.spec.ts, e2e/fakes/qbit.ts, e2e/global-setup.ts]
issue: 614
source: review
date: 2026-04-17
---
Spec's interaction contract said the Grab button has a pending state, but the test only asserted the success toast. Catching the pending state required injecting ~150ms latency into the qBit fake's `/api/v2/torrents/add` — in a hermetic setup with instant fakes, React can't re-render the `disabled` attribute before the mutation settles and the modal unmounts. Lesson: when asserting transient UI state (pending, loading, spinner), the test must control the timing of the underlying async operation — not trust the hermetic fake to be "fast enough" to race against. Add configurable per-endpoint latency to fakes from the start.
