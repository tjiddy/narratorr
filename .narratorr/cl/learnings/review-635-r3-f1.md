---
scope: [frontend]
files: [src/client/hooks/useRetryImportAvailable.ts, src/client/pages/library/LibraryBookCard.tsx]
issue: 635
source: review
date: 2026-04-17
---
When a preflight check is added to one surface (detail page) but the same affordance exists on another surface (library grid), the check must be applied consistently. The "impractical for grid" rationale doesn't hold when the check is a single lightweight API call per failed book. Extract preflight hooks to shared files from the start so all surfaces use the same logic.
