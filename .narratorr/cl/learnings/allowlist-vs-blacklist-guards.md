---
scope: [core]
files: [src/core/download-clients/transmission.ts, src/core/download-clients/deluge.ts]
issue: 565
date: 2026-04-15
---
When adding a new variant to a discriminated union, adapters that use blacklist guards (`if (type === 'nzb-url') throw`) silently fall through on the new type. Allowlist guards (`if (type !== 'torrent-bytes' && type !== 'magnet-uri') throw`) are future-proof — TypeScript narrows correctly and new variants are rejected by default. Prefer allowlist guards in adapter `addDownload()` methods.
