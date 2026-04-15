---
scope: [core]
files: [src/core/download-clients/nzbget.ts]
issue: 565
date: 2026-04-15
---
NZBGet `append` RPC uses the same method for both URL and base64 content — the difference is `params[0]` (filename): empty string triggers URL mode, a filename like `upload.nzb` triggers content mode with `params[1]` as base64 data. The shared `appendNzb` helper was needed to keep `addDownload` under the eslint complexity limit of 15.
