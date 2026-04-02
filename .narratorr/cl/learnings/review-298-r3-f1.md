---
scope: [scope/frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/hooks/useSearchStream.ts]
issue: 298
source: review
date: 2026-04-02
---
Setting `phase = 'results'` immediately in `showResults()` blanked the modal because Phase 2 only rendered from `state.results` (still null). The fix added a "Finalizing results..." loading state when phase is results but data hasn't arrived. Lesson: when a hook flips phase before data arrives, the consuming component must handle the intermediate state (phase=X but data=null). Always check that every possible state combination renders something meaningful.
