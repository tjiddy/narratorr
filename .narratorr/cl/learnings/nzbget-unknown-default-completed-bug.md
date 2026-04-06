---
scope: [core]
files: [src/core/download-clients/nzbget.ts]
issue: 373
date: 2026-04-06
---
NZBGet's `mapHistoryStatus()` defaulted unknown status strings to `'completed'`, which is the most dangerous possible default — any unrecognized status would trigger the quality gate on an incomplete download. Safe defaults for download status should always be `'downloading'` (keep waiting) not `'completed'` (fire quality gate). The existing test asserting this behavior (`handles unknown history status (fallback to completed)`) was testing the bug, not the correct behavior.
