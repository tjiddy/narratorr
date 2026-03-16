---
scope: [scope/backend, scope/services]
files: [src/server/services/import.service.ts, src/core/download-clients/qbittorrent.ts, src/core/download-clients/deluge.ts]
issue: 360
source: spec-review
date: 2026-03-14
---
AC7 listed magic numbers (`86400000`, `60_000`) without verifying which ones actually exist in production backend code vs test files or client components. The reviewer grepped and found `86400000` only in tests and a client component, while `60_000` appeared in many unrelated modules. Root cause: the spec was written from the debt scan findings without verifying each literal's actual location. For dedup/cleanup specs, always grep each literal and provide an explicit file:line punch list — don't leave it open-ended.
