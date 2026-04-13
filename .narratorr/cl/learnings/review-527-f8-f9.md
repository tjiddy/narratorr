---
scope: [scope/core, scope/services]
files: [src/server/services/download.service.ts]
issue: 527
source: review
date: 2026-04-13
---
When inserting a pre-processing step (like URL resolution) before adapter submission and DB insert, service-level tests must cover: (1) the failure short-circuit — verify that when the pre-processing step throws, neither the adapter nor the DB is called (no partial state), and (2) value persistence — verify that values extracted during pre-processing (like `infoHash`) are actually written to the DB row, not just passed to the adapter. Testing only the adapter call misses the DB persistence path.
