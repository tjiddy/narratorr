---
scope: [core]
files: [src/core/download-clients/sabnzbd.ts]
issue: 655
date: 2026-04-20
---
SABnzbd's queue `kbpersec` field is computed in the upstream source as `bytes_per_sec / 1024` (binary KiB, not decimal kB). Converting back to bytes/sec requires `* 1024`, not `* 1000`. The same convention applies to `*SizeMB` fields across SABnzbd and NZBGet — both are binary MiB, matching the existing `sizeMb * 1024 * 1024` pattern in these adapters. Mixing decimal and binary conversions under-reports by ~2.4% per unit step, which is small enough to look "right" in casual review but compounds visibly across GB-scale totals.
