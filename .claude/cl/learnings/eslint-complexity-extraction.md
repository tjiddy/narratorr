---
scope: [core]
files: [src/core/download-clients/deluge.ts]
issue: 264
date: 2026-03-08
---
ESLint complexity limit is 15 in this project. When adding conditional branches (like a `torrentFile` path) to an already-complex method, extract the new path into a private helper method to stay under the limit. Deluge's `addDownload` hit 18 after adding torrentFile support — fixed by extracting `addTorrent()`.
