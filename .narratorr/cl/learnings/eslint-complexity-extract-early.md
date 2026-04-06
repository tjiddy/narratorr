---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts]
issue: 367
date: 2026-04-06
---
Adding a new URL routing branch with try/catch to `addDownload` pushed cyclomatic complexity from ~12 to 18 (limit 15). Extract new logic into a private method from the start rather than inlining and refactoring after lint fails — saves a fix iteration in verify.
