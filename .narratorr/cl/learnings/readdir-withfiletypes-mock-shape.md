---
scope: [backend]
files: [src/server/services/tagging.service.test.ts]
issue: 405
date: 2026-04-07
---
When extracting a shared helper that calls `readdir(dir, { withFileTypes: true })` but the callers' tests mock `readdir` returning plain string arrays, the mock must be updated to return Dirent-shaped objects when `withFileTypes` is set. A smart mock that checks `opts?.withFileTypes` and auto-converts is the cleanest pattern — it supports both call shapes from one mock definition.
