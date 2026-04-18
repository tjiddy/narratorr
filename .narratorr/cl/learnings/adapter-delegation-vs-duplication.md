---
scope: [backend, services]
files: [src/server/services/import-adapters/auto.ts, src/server/services/import-orchestrator.ts]
issue: 636
date: 2026-04-17
---
When an adapter needs the same 7+ side effects as an existing orchestrator method, delegate to the orchestrator rather than duplicating. AutoImportAdapter.process() is ~35 lines because it calls ImportOrchestrator.importDownload() which owns all SSE, tagging, post-processing, notifications, events, and blacklist logic. ManualImportAdapter duplicates some of these because it has a fundamentally different import pipeline (library scan vs download import).
