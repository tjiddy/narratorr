---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx]
issue: 317
date: 2026-04-03
---
Adding async detection logic (blur handler, loading state, error state, API call) to an existing form component easily exceeds ESLint's cyclomatic complexity (15) and max-lines (150) limits. Extract the async logic into a custom hook (`useMamDetection`) and the display into focused components (`MamStatusBadge`, `DetectionOverlay`) upfront to avoid a verify-fail-then-refactor cycle. This is predictable for any "detect on blur" feature.
