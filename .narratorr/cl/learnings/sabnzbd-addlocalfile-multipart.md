---
scope: [core]
files: [src/core/download-clients/sabnzbd.ts]
issue: 565
date: 2026-04-15
---
SABnzbd's `mode=addlocalfile` uses multipart POST (not query params like `addurl`). The response shape is identical (`{ status, nzo_ids }`). Options (category, priority) go in query params on the URL, not in the form body. The file field name is `name` (not `file` or `nzbfile`).
