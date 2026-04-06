---
scope: [backend, core]
files: [src/server/services/indexer.service.ts]
issue: 372
date: 2026-04-06
---
When adding pre-flight logic to both `searchAll()` and `searchAllStreaming()`, extract a shared private helper (`preSearchRefresh()`) that returns a skip/continue signal. This avoids duplicating Mouse-check, DB persistence, and error fallback logic. The helper pattern also keeps each search method's complexity under the ESLint cyclomatic limit.
