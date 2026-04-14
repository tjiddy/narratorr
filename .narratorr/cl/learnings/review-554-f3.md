---
scope: [backend]
files: [src/server/services/discovery.service.ts, src/server/services/discovery.service.test.ts]
issue: 554
source: review
date: 2026-04-14
---
Boundary-critical constants (chunk sizes for SQLite bind limits) need service-level tests that actually cross the boundary, not just unit tests on the chunking utility. A regression that changes `999` to `99` or `47` to `470` passes utility tests but fails on real data volumes. Always test the integration path at the boundary, not just the helper.
