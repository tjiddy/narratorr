---
scope: [scope/frontend]
files: [apps/narratorr/src/client/components/settings/DownloadClientFields.tsx, apps/narratorr/src/client/components/settings/useFetchCategories.ts]
issue: 220
source: review
date: 2026-02-24
---
Reviewer caught missing empty-state UI when category fetch returns zero results. The dropdown only rendered when `categories.length > 0`, so a successful fetch with empty results showed nothing — violating the AC for empty results. Root cause: the hook set `showDropdown(false)` for empty results, and the component gated the dropdown on `categories.length > 0`. Both needed to allow the empty state through. This was a spec gap — the AC mentioned "No categories found" but the implementation focused on the happy path without explicitly handling the empty-success case.
