---
scope: [backend]
files: [src/server/utils/sanitize-log-url.ts, src/core/utils/download-url.ts]
issue: 545
date: 2026-04-14
---
`new URL('magnet:?xt=urn:btih:...')` returns `origin: "null"` and `pathname: ""` — the standard `origin + pathname` sanitization contract doesn't work for magnet URIs. Protocol-aware branching is required: parse the info hash with a regex and format as `magnet:[hash]`. The `parseInfoHash` function in `src/core/utils/magnet.ts` handles both hex (40 chars) and base32 (32 chars) formats.
