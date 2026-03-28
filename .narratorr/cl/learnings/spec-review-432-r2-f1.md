---
scope: [scope/backend, scope/frontend]
files: []
issue: 432
source: spec-review
date: 2026-03-17
---
Reviewer caught that the spec referenced `src/shared/schemas/index.ts` as the shared schemas barrel, but the actual file is `src/shared/schemas.ts` (flat file, not directory with index). This was a carry-over from the round 1 fix where the enrichmentStatus AC was rewritten but the barrel path wasn't verified against the filesystem. The gap: not running a file-existence check on every path named in the AC before posting the response.
