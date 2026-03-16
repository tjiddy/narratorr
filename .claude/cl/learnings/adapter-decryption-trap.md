---
scope: [backend, services]
files: [src/server/services/indexer.service.ts, src/server/services/download-client.service.ts]
issue: 315
date: 2026-03-11
---
When adding encryption to service layers, the `getAdapter()` method is a subtle trap. Raw DB queries in `searchAll()`/`pollRss()` return encrypted rows, and `getAdapter()` passes them to `createAdapter()` which uses the settings directly for HTTP requests. The adapter receives encrypted API keys and sends them in requests. Fix: always decrypt the row in `getAdapter()` before creating the adapter. This was caught by the search-grab-flow e2e test.
