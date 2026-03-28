---
scope: [frontend]
files: [src/client/components/ToolbarDropdown.tsx, src/client/pages/library/StatusDropdown.tsx, src/client/pages/library/SortDropdown.tsx, src/client/pages/library/OverflowMenu.tsx]
issue: 148
date: 2026-03-26
---
`ToolbarDropdown` is a shared portal primitive used by three callers: `StatusDropdown`, `SortDropdown`, and `OverflowMenu`. Changing the z-index class on `ToolbarDropdown` affects all three simultaneously — including OverflowMenu which was not mentioned in the original spec. The spec review caught this blast radius and required the spec to list all callers explicitly. When planning changes to a shared primitive, always grep for all callers and enumerate them in the spec's scope/AC before implementation.
