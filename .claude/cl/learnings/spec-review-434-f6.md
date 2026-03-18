---
scope: [scope/backend, scope/services]
files: [src/server/services/download.service.ts]
issue: 434
source: spec-review
date: 2026-03-18
---
Spec test plan said cancel() should propagate adapter.removeDownload failures, but the code catches them (best-effort) and continues. Book deletion depends on this. When specifying error handling semantics, check callers that depend on the current behavior before proposing changes.
