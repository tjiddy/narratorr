---
scope: [backend]
files: [src/server/services/library-scan.service.test.ts]
issue: 350
source: review
date: 2026-04-04
---
Tests only covered `importSingleBook()` genre persistence but not `confirmImport()` background processing. The background path has different data-flow characteristics (fire-and-forget, stale metadata, async timing) that the inline path doesn't. When a feature has two entry points with different data-flow patterns, both must be tested independently — testing one doesn't validate the other.
