---
scope: [backend]
files: [src/server/services/import-list.service.test.ts]
issue: 393
date: 2026-03-15
---
Flat DB mocks (where `db.where`, `db.values`, `db.set` are all on the same object) are fundamentally different from the shared `createMockDb()` pattern (where `db.select()` returns a separate chain). Migrating from flat to layered requires rewriting every test's mock setup and assertions. When a test file uses a flat mock with 20+ tests, it's more pragmatic to Proxy-ify the internal method list than to rewrite the entire file to use the shared pattern.
