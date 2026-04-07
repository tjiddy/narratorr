---
scope: [backend, services]
files: [src/server/utils/import-helpers.ts]
issue: 397
source: review
date: 2026-04-07
---
When adding a new code path (multi-disc) that collects files from multiple sources (disc folders + non-disc folders), duplicate detection must cover ALL pairs: within-disc (handled by sequential naming), non-disc vs disc (was added), AND within non-disc files themselves (was missed). The self-review caught one collision vector but missed another. Lesson: enumerate all collision pairs explicitly when merging file lists from different sources.
