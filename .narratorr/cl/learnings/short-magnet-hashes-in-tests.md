---
scope: [core, backend]
files: [src/server/services/download.service.test.ts, src/core/utils/download-url.ts]
issue: 527
date: 2026-04-13
---
Test fixtures using abbreviated magnet URIs like `magnet:?xt=urn:btih:abc` break when validation is added to the resolver — `parseInfoHash()` requires a 40-char hex or 32-char base32 hash. Always use full-length hex hashes in test fixtures (e.g., `0000000000000000000000000000000000000abc`) to avoid cascade failures when upstream validation tightens.
