---
scope: [scope/frontend]
files: [src/client/pages/settings/SearchSettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.tsx]
issue: 341
source: spec-review
date: 2026-03-11
---
Spec listed 9 named sections but didn't account for cross-category field ownership — SearchSettingsSection owns both `search.*` and `rss.*` fields, ProcessingSettingsSection owns both `processing.*` and `tagging.*`. The elaborate step's codebase exploration didn't check which schema categories each section component actually registers fields for. Fix: when a spec involves per-section refactoring, `/elaborate` should grep for all `register('category.')` calls in each section component to map field ownership across categories.
