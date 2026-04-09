---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.tsx]
issue: 439
source: review
date: 2026-04-09
---
The issue spec included per-option descriptions for the search priority dropdown ("Prioritize higher bitrate..." for quality, "Prioritize narrator match..." for accuracy). The implementation replaced these with a single generic description to avoid the `react-hooks/incompatible-library` lint rule from `watch()`. The reviewer caught this as an AC miss. Fix: show both descriptions always (stacked), avoiding `watch()` entirely.