---
scope: [core, backend]
files: [src/core/indexers/registry.test.ts]
issue: 291
source: review
date: 2026-04-02
---
Factory tests that only assert `adapter.type` and `adapter.name` don't prove the factory's defaulting behavior. When a factory owns a defaulting contract (applying fallback values with ??), tests must verify the actual output values — not just that construction succeeded. The fix was to use MSW to capture the adapter's search URL and verify the query params contain the expected defaults/preserved values.
