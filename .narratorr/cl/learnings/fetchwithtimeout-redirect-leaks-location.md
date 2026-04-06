---
scope: [core]
files: [src/core/utils/fetch-with-timeout.ts, src/core/download-clients/qbittorrent.ts]
issue: 367
date: 2026-04-06
---
`fetchWithTimeout` intentionally includes the `Location` header value in its redirect error message (line 32). Any caller that needs URL redaction (e.g., for passkey/token safety) must catch redirect errors and replace them with a sanitized message — the helper does not sanitize for you.
