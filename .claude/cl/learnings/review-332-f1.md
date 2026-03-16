---
scope: [backend]
files: [src/server/services/event-history.service.ts]
issue: 332
source: review
date: 2026-03-10
---
Used `lte` (less-than-or-equal) instead of `lt` (strictly less-than) for retention pruning. Events at exactly the cutoff boundary would be incorrectly deleted. The spec said "older than" which means strictly less-than. Pattern: when a spec says "older than N days", always use `lt` not `lte` — the boundary event is exactly N days old, not older.
