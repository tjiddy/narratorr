---
scope: [backend, services]
files: [src/server/services/download.service.ts]
issue: 57
date: 2026-03-22
---
The pattern for adding a nullable leftJoin field to DownloadService is: add `indexer: indexers` to `select({})`, chain `.leftJoin(indexers, eq(downloads.indexerId, indexers.id))`, and map `indexerName: r.indexer?.name ?? null`. The `??` operator (not `||`) is correct here because `null` is the intended sentinel for deleted indexers — `|| undefined` would lose the distinction. All four query methods (getAll, getById, getActive, getActiveByBookId) must be updated identically; missing one causes inconsistent shapes across routes.
