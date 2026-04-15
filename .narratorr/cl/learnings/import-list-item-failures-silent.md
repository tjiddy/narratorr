---
scope: [backend]
files: [src/server/services/import-list.service.ts, src/server/services/import-list.service.test.ts]
issue: 592
date: 2026-04-15
---
Individual `processItem` failures in `syncList` are swallowed (warn-logged, not thrown). The outer `syncDueLists` catch only fires for provider-level errors (fetchItems rejection, factory throw). This means `lastSyncError` stays null even if every item fails — by design, since item failures are per-item concerns, not list-level sync failures. Tests must distinguish between item-level and list-level error paths.
