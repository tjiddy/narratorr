---
scope: [backend, frontend]
files: [src/shared/schemas/settings/search.ts, src/shared/schemas/settings/registry.ts, src/server/services/settings.service.test.ts]
issue: 439
date: 2026-04-09
---
Adding a new field to a settings schema triggers a blast radius across ~57 test files. Most use `createMockSettings()` which handles defaults automatically, but tests with inline `toEqual()` assertions on exact settings objects (like settings.service.test.ts) must be updated manually. Search for hardcoded `{ intervalMinutes:` patterns across all test files to find them upfront.