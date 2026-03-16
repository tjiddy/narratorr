---
scope: [scope/backend, scope/services]
files: []
issue: 355
source: spec-review
date: 2026-03-13
---
When specifying sort orders across multiple services, verify each service's actual schema column names rather than assuming they follow the same convention. Blacklist uses `blacklistedAt` (not `createdAt`/`addedAt`) and had no existing orderBy — the spec assumed uniform sorting that didn't exist.
