---
scope: [frontend]
files: [src/client/components/settings/DownloadClientFields.tsx, src/client/components/ToolbarDropdown.tsx]
issue: 240
date: 2026-03-31
---
`backdrop-filter` on glass-card elements creates a stacking context that traps `z-index` of descendants. z-index alone can never escape it — portals to `document.body` are the only fix. The project already has `ToolbarDropdown` as the canonical portal dropdown pattern (used by StatusDropdown, OverflowMenu). Always check for it before building a new one.
