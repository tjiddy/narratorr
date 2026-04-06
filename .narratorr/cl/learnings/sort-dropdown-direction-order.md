---
scope: [frontend]
files: [src/client/pages/library/SortDropdown.tsx]
issue: 365
date: 2026-04-06
---
Sort dropdown direction order is field-dependent: Date Added shows desc (Newest) first because it's the natural default, while alphabetical fields (title, author) show asc (A→Z) first. A single `directions` array used for all fields gets the order wrong for one group. Use a `fieldDirections` map with a default fallback to handle per-field ordering.
