---
scope: [backend]
files: [src/server/services/discovery.service.ts]
issue: 524
source: review
date: 2026-04-13
---
When adding a status-flip endpoint (pending → added), guard against ALL non-target statuses, not just the target status. The initial implementation only checked `status === 'added'` (idempotent), but missed `status === 'dismissed'`, allowing a dismissed suggestion to be silently rewritten. Always enumerate the valid source states explicitly (`if (row.status !== 'pending')`) rather than just checking the target.
