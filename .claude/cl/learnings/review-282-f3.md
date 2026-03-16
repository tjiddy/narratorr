---
scope: [scope/frontend]
files: [src/client/pages/library/useLibraryFilters.ts]
issue: 282
source: review
date: 2026-03-10
---
The narrator dropdown used a plain `Set<string>` which preserved case variants ('Michael Kramer' vs 'michael kramer') as separate entries, even though the filter itself matched case-insensitively. Fixed by using a `Map<string, string>` keyed by lowercase to keep the first occurrence. Lesson: when the filter is case-insensitive, the dropdown options must also deduplicate case-insensitively — otherwise the UI is inconsistent.
