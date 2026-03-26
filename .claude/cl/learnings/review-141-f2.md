---
scope: [scope/frontend]
files: [src/client/pages/library-import/LibraryImportPage.tsx, src/client/pages/library-import/LibraryImportPage.test.tsx]
issue: 141
source: review
date: 2026-03-26
---
The reviewer caught that the new `rowIndexMap` change updated both the toggle and edit callbacks, but only the toggle callback had a page-level test proving correct index lookup. The edit callback wiring was changed in the same commit but left without direct coverage.

Root cause: partial-layer test coverage — when a refactor touches two callbacks in the same line change (`onToggle` and `onEdit`), a test was written for one (toggle) but not both. This is a classic "test the change you made" gap: the changed line `onEdit={() => setEditIndex(rowIndexMap.get(row) ?? -1)` has no test verifying the modal opens with the correct row data.

What would have prevented it: When a change touches N symmetrical paths (both callbacks use the same map), write coverage for each path. The rule "every changed code branch gets a test" applies to sibling paths too. The plan should have listed one test per callback.
