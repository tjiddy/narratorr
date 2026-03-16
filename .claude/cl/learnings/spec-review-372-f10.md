---
scope: [scope/backend, scope/frontend]
files: [src/client/pages/library/helpers.ts, src/client/pages/library/SortControls.tsx]
issue: 372
source: spec-review
date: 2026-03-15
---
When moving sort logic from client-side to server-side, the spec must enumerate every accepted sort field with its server-side semantics. Computed fields (quality=MB/hr, size=audioTotalSize??size) and special behaviors (null ordering, leading article stripping, stable secondary sort) need explicit definitions because the server implementation can't just copy the client-side helper functions.
