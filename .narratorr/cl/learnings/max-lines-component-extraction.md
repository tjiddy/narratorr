---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 210
date: 2026-03-29
---
ESLint enforces max-lines (400) per file. LibrarySettingsSection.tsx was already at 426 lines before adding features. Adding presets/separator/case pushed it further. Solved by: (1) extracting NamingTokenModal to its own file, (2) collapsing label maps to single-line objects, (3) merging 4 preview memos into 2 grouped memos, (4) removing blank lines between tightly-related declarations. When a component is near the limit, plan extraction up front rather than scrambling to cut lines after implementation.
