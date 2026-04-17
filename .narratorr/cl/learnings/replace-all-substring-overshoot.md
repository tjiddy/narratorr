---
scope: [frontend]
files: [src/client/pages/activity/MergeActivityCard.test.tsx, src/client/pages/activity/SearchActivityCard.test.tsx]
issue: 634
date: 2026-04-17
---
When using replace_all to rename a component (e.g., `MergeCard` -> `MergeActivityCard`), type names that contain the component name as a prefix (e.g., `MergeCardState`) get caught in the replacement, producing nonexistent types like `MergeActivityCardState`. Always use targeted, non-replace-all edits for renames where the old name is a substring of other symbols, or verify type names after bulk replacement.
