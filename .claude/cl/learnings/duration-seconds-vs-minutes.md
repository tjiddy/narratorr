---
scope: [frontend]
files: [src/client/pages/discover/SuggestionCard.tsx]
issue: 367
date: 2026-03-16
---
Backend `SuggestionRow.duration` is in seconds, but `formatDuration()` in `src/client/lib/helpers.ts` expects minutes. Need a conversion wrapper (`Math.round(seconds / 60)`) when using formatDuration with suggestion data. Other parts of the app (books) already store duration in minutes so this inconsistency is specific to the suggestions table.
