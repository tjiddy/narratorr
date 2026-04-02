---
scope: [backend, core]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 299
source: review
date: 2026-04-02
---
Blanket catch blocks that collapse "path doesn't exist" (ENOENT) and "deletion failed" (EACCES, I/O error) into the same branch lose the retry path. Split stat() precheck (path existence) from rm() execution, and only return success when the path is confirmed gone. The self-review didn't catch this because the test only covered the adapter-error partial-failure path, not the filesystem-error path. A dedicated "rm() throws" test case would have caught it during implementation.
