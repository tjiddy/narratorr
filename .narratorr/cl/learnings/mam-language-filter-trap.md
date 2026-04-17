---
scope: [core]
files: [src/core/indexers/myanonamouse.ts, src/core/utils/language-codes.ts]
issue: 614
date: 2026-04-16
---
MAM's numeric `lang_code: '1'` for English passes through `normalizeLanguage` unchanged (not in ISO_639_TO_NAME or KNOWN_NAMES), which then fails the default `metadataSettings.languages: ['english']` filter — result: search returns 0 matches silently. Our fake now uses `'en'` (which normalizes to `'english'`). Real MAM responses seem to send the numeric code, so `normalizeLanguage` probably needs a numeric code map to avoid this dropping real English results. File as a backlog item if you see user reports of "0 results" despite valid searches.
