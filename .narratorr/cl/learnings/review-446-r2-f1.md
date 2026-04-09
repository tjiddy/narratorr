---
scope: [backend]
files: [src/server/utils/folder-parsing.ts, src/server/utils/folder-parsing.test.ts]
issue: 446
source: review
date: 2026-04-09
---
When extracting a "raw" variant of a function that mirrors the branch structure of its cleaned counterpart, the raw variant needs its own dedicated branch-level tests — not just an indirect path through the route tests. Without direct unit tests, a drift between the raw and cleaned parsers (e.g., a new pattern added to one but not the other) won't be caught until it manifests as a broken trace in production.
