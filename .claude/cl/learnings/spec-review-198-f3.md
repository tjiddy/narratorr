---
scope: [scope/frontend, scope/backend]
files: []
issue: 198
source: spec-review
date: 2026-03-12
---
Spec defined a timeout field as "optional number, default 300" but didn't account for how the existing settings form architecture handles defaults — `stripDefaults()` removes Zod defaults for form schemas, `valueAsNumber` turns empty input into NaN, and `settingsToFormData()` merges with DEFAULT_SETTINGS. Numeric settings fields need an explicit UI/persistence contract: what the input shows, what happens when cleared, and what `GET /api/settings` returns. The `/elaborate` skill should check existing numeric field patterns (bitrate, maxConcurrentProcessing) before accepting a new numeric field AC.
