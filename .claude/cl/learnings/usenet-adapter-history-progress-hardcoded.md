---
scope: [core, backend]
files: [src/core/download-clients/sabnzbd.ts, src/core/download-clients/nzbget.ts]
issue: 117
date: 2026-03-25
---
Both SABnzbd and NZBGet adapters hardcode `progress: 100` for ALL history items, including failed ones. History APIs return completed items (success or failure) with no meaningful progress value, so adapters saturate it. The correct pattern is: compute `status` first, then set `progress: status === 'error' ? 0 : 100`. qBittorrent does not have this problem because it tracks real progress even for error states. When adding a new Usenet adapter, always check the history-item mapping for this same pattern.
