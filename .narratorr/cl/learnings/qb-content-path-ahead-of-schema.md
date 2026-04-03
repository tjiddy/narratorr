---
scope: [core]
files: [src/core/download-clients/qbittorrent.ts, src/core/download-clients/schemas.ts, src/server/__tests__/msw-handlers.ts]
issue: 323
date: 2026-04-03
---
qBittorrent's `content_path` field was already present in MSW test mocks (`msw-handlers.ts:72`, `multi-entity.e2e.test.ts:395`) but missing from the schema and interface — the `.passthrough()` on the schema silently let it through without typing. When adding optional API fields, always check existing test fixtures first — they may already provide the field, meaning the schema/interface just need to catch up rather than requiring mock updates.
