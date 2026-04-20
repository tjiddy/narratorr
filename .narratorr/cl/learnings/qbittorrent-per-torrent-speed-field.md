---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts, src/core/download-clients/schemas.ts]
issue: 655
date: 2026-04-20
---
qBittorrent WebUI API v2 exposes download rate in two different fields: `dl_info_speed` is the GLOBAL transfer rate under `/api/v2/transfer/info`, while per-torrent rate is `dlspeed` under `/api/v2/torrents/info`. A spec that said "add `dl_info_speed` to `qbTorrentSchema`" would compile cleanly (schema uses `.passthrough()`) and pass all mock-based tests, but would populate nothing in production because qBittorrent never returns that key on per-torrent responses. Next time: when a spec names an API field, verify it against the endpoint the adapter actually calls, not just against the adapter's local schema.
