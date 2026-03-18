---
scope: [scope/backend, scope/services]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 435
source: review
date: 2026-03-18
---
When extracting code from one class to another, don't add try/catch around operations that previously propagated errors. The reviewer caught that wrapping revertBookStatus() in try/catch changed the failure contract: manual reject now returned 200 on partial rollback instead of 500, and auto-reject no longer fell into the outer catch that sets pending_review. The fix: preserve the original error propagation behavior exactly. If the original code didn't catch it, the extraction shouldn't either.
