---
scope: [core]
files: [src/server/services/library-scan.service.test.ts]
issue: 333
source: review
date: 2026-04-04
---
Parser-level unit tests proving output equality (title/author match between 2-part and 3-part paths) don't prove the actual dedup behavior works. The `scanDirectory()` dedup path uses `slugify(author)` and a Map lookup — if that wiring broke, parser-only tests would still pass. Always add a service-level test that drives the full caller path (mock discoverBooks → assert isDuplicate/duplicateReason) when changing parser output that feeds dedup logic.
