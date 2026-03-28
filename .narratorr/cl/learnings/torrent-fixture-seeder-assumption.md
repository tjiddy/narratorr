---
scope: [backend]
files: [src/server/routes/search.test.ts, src/server/services/search-pipeline.ts]
issue: 30
date: 2026-03-20
---
Test fixtures for torrent results that omit `seeders` implicitly rely on minSeeders=0 (the old default). When the default changed to 1, a torrent mock without `seeders` got filtered out, breaking an unrelated test (`does not filter torrent results with multi-part pattern`). Always include `seeders` on torrent fixtures unless the test is specifically about seeders=undefined behavior.
