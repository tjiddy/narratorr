---
scope: [scope/backend, scope/services]
files: [src/shared/schemas/settings/search.ts]
issue: 360
source: spec-review
date: 2026-03-14
---
Round 2 caught that the deep-merge test plan still used fake `search` field names (`maxResults`, `includeAdult`) even after round 1 fixed the "nested quality" issue. The actual `search` schema has `intervalMinutes`, `enabled`, `blacklistTtlDays`. Root cause: when fixing F5 in round 1, I replaced the quality example but didn't also verify the search example against the real schema. Fix for both examples should have been done together since they share the same root cause (writing test scenarios without reading the schema).
