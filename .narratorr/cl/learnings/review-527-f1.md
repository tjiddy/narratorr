---
scope: [scope/core]
files: [src/core/utils/download-url.ts]
issue: 527
source: review
date: 2026-04-13
---
Relative `Location` headers (e.g., `/file.torrent`) are valid HTTP redirects but were rejected as "unsupported scheme" because the redirect handler only checked for absolute `http://`/`https://` prefixes. Missed because all test fixtures used absolute redirect URLs. When implementing redirect handling, always resolve `Location` against the current URL using `new URL(location, currentUrl)` to handle relative paths.
