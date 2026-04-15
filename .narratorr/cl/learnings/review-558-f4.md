---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts, src/core/download-clients/deluge.ts]
issue: 558
source: review
date: 2026-04-15
---
When converting raw `Error` throws to typed error classes, distinguish between credential failures (auth error) and transport failures (generic error) in login methods. A non-2xx HTTP response from a login endpoint usually means the server is unreachable or misconfigured, not that credentials are wrong. Only throw auth errors for credential-specific indicators (e.g., qBittorrent's "Fails." response, Deluge's `result !== true`). This matters because auth errors map to 401 in the error handler, which would mislead users about the actual problem.
