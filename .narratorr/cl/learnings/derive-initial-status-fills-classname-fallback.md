---
scope: [frontend]
files: [src/client/components/settings/indexer-fields/mam-fields.tsx]
issue: 383
date: 2026-04-06
---
`deriveInitialMamStatus` always fills classname with a fallback ('VIP'/'User' based on isVip) when the persisted value is missing. The `?? 'Unknown'` fallback in `MamAccountCard` only triggers through the API detection path (via `metadataToMamStatus`) when the adapter returns undefined classname. Tests for "Unknown" must use the detection path, not the form-hydration path — the form wrapper approach will always show the derived fallback.
