---
scope: [frontend, ui]
files: [src/client/pages/activity/DownloadProgress.tsx]
issue: 655
date: 2026-04-20
---
Numbers that update via SSE (progress percentage, download speed, bytes-of-total) need `tabular-nums` applied at the container level or the digit-width variance causes layout jitter on every tick. Tailwind ships `tabular-nums` as a utility — no custom CSS needed. Pattern: apply it once on the row container that holds all the live-updating labels, not on each individual `<span>`. Also related: the `showSpeed` guard should use `typeof x === 'number'`, not a truthy check, so `0` (the "stalled" signal) still renders.
