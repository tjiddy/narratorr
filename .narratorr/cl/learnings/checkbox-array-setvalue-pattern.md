---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx]
issue: 291
date: 2026-04-02
---
React Hook Form's `register()` doesn't work for numeric array fields (checkbox groups with numeric IDs). Use `setValue()`/`watch()` pattern instead, matching the existing NotifierCard.tsx event checkbox approach. For single-select numeric fields, `register('field', { valueAsNumber: true })` works correctly (matching pageLimit pattern in IndexerFields.tsx).
