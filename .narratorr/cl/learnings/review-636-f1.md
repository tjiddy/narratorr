---
scope: [frontend]
files: [src/client/pages/library/BookContextMenu.tsx]
issue: 636
source: review
date: 2026-04-18
---
BookContextMenu keyboard handler hardcoded `actions = [onSearchReleases, onRemove]` (2 items), but the menu can render 3 buttons when `onRetryImport` is present. This caused ArrowDown/Enter to dispatch wrong actions. The fix: build the actions array dynamically based on which props are provided. Lesson: when a component's rendered children are conditional, keyboard navigation must derive its item count from the same condition — never hardcode the count.
