---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx]
issue: 29
date: 2026-03-20
---
`result.size != null` guards only against null/undefined — negative sentinels like `-1` (commonly used by indexers to mean "unknown size") pass this check and reach the formatter. Display guards for optional numeric fields should use `!= null && > 0` when zero/negative has no valid display meaning, not just `!= null`.
