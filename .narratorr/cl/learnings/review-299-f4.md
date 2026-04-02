---
scope: [backend, core]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 299
source: review
date: 2026-04-02
---
Node.js filesystem errors carry a `.code` property (ENOENT, EACCES, etc.). A blanket catch on `stat()` that assumes "path doesn't exist" is wrong — permission errors and I/O errors should preserve retry state. Always check `error.code === 'ENOENT'` specifically for "file not found" semantics. This is the same pattern as the fallbackFileDelete method's existing handling, but was missed when writing the new deferredDeleteFiles helper.
