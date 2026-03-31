---
scope: [backend, services]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 248
source: review
date: 2026-03-31
---
Reviewer caught that `fallbackFileDelete()` fell through to `rm()` when `downloadClientService.getById()` threw an error. The catch block only logged and continued, bypassing the ancestry safety check entirely. When a safety check depends on a lookup that can fail, the failure path must be conservative (skip the dangerous operation), not permissive (proceed without the check).
