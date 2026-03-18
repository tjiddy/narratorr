---
scope: [backend, services]
files: [src/server/services/quality-gate.service.test.ts]
issue: 356
source: review
date: 2026-03-15
---
When testing chunking logic, asserting total call count is insufficient if multiple chunk sizes produce the same call count. Use input sizes that sit exactly at the boundary where chunk size difference changes the number of chunks. For EVENT_CHUNK=998 vs 999, passing exactly 999 IDs differentiates them (998 → 2 chunks, 999 → 1 chunk). Inspecting Drizzle SQL predicate internals is fragile due to circular references — use boundary-crossing input sizes instead.
