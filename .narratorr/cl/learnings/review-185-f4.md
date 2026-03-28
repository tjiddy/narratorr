---
scope: [frontend]
files: [src/client/components/manual-import/BookEditModal.test.tsx]
issue: 185
source: review
date: 2026-03-28
---
When testing `initialResults` fallback logic that seeds `useAudnexusSearch`, asserting `getAllByText(title).length >= 1` is vacuous because the metadata preview always renders the same title independently. Must assert an observable that depends on `searchResults` being seeded — e.g., the "Other matches" heading (only renders when `searchResults.length > 0`) or `getAllByText(title).length >= 2` (preview + results list item).
