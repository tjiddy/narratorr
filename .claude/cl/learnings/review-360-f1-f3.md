---
scope: [backend, services]
files: [src/server/services/download-client.service.ts, src/server/services/indexer.service.ts, src/server/services/import-list.service.ts]
issue: 360
source: review
date: 2026-03-14
---
When extracting shared logic (resolveSentinelFields), the existing tests only verified return values and cache behavior — not that the sentinel-to-encrypted-value swap actually happened in the persisted data. The reviewer caught that sentinel preservation was untested at the service level. When refactoring security-sensitive code paths (encryption, auth, sentinel handling), add a test that asserts the exact values passed to the persistence layer, not just that the operation "succeeded."
