---
scope: [frontend]
files: [src/client/pages/manual-import/useManualImport.test.ts, src/client/pages/library/useLibraryFilters.test.ts, src/client/pages/activity/useActivity.test.ts, src/client/hooks/useCrudSettings.test.ts]
issue: 146
date: 2026-03-26
---
When regrouping a hook's return shape, test files have dozens of `result.current.flatValue` references that all need to become `result.current.group.flatValue`. The fastest approach is a series of targeted `sed -i` substitutions per group, run before writing any new assertions. Map each key to its group first, then run one sed per group. This avoids editing 150+ lines by hand and completes the mechanical part in seconds, leaving only the new shape-assertion tests to write manually.
