---
scope: [core]
files: [src/core/download-clients/deluge.ts, src/core/download-clients/transmission.ts]
issue: 270
date: 2026-04-01
---
Deluge and Transmission adapters already had correct error handling (body-level error field checks, result === "success" checks, duplicate torrent handling) despite being written without live testing. The existing test suites covered these paths well. When verifying adapter correctness, read the full test suite first — most verification ACs may already be covered, saving significant implementation time.
