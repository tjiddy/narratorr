---
scope: [scope/frontend]
files: [src/client/hooks/useEventHistory.ts]
issue: 389
source: review
date: 2026-03-15
---
Reviewer caught that `useBookEventHistory.deleteMutation` only invalidated the book-specific query key, not the shared `eventHistory` root prefix. This meant deleting from the book details page left the global activity/event-history views stale.

Missed because: when copying the `markFailedMutation` pattern from `useEventHistory` to `useBookEventHistory`, the existing markFailed handler already only invalidated book-specific keys (plus `book` and `blacklist`), so the delete mutation followed that same pattern without considering that deletes affect the global event list too. The `useEventHistory.deleteMutation` correctly invalidated `root()`, but the book variant didn't.

Prevention: when adding cross-view mutations, always check which views share the same data and ensure all relevant query prefixes are invalidated. A checklist step in /plan for "which other views display this data?" would catch this.
