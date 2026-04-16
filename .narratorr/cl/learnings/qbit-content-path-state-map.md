---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts]
issue: 614
date: 2026-04-16
---
`qbittorrent.mapState` downgrades `uploading`/`stalledUP`/`forcedUP`/etc from `seeding` back to `downloading` if `relative(savePath, contentPath)` starts with `..` or equals contentPath. This is a real race-condition guard (incomplete→complete directory move) but means our qBit fake must set `content_path = <save_path>/<torrent_name>` — not just the bare name, and not outside save_path. Getting this wrong means the monitor never sees `completed`, quality gate never fires, import never runs.
