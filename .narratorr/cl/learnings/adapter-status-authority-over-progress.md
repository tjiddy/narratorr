---
scope: [backend, core]
files: [src/server/jobs/monitor.ts, src/core/download-clients/types.ts]
issue: 373
date: 2026-04-06
---
Monitor completion detection must use adapter-reported status, never progress percentage. Progress can reach 100% while the client is still post-processing (SABnzbd extracting, qBT moving files between directories). The adapter's status field is the only reliable completion signal because it reflects the client's internal state machine.
