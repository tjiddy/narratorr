---
scope: [backend, frontend, services]
files: [src/server/services/quality-gate.types.ts, src/server/services/quality-gate-orchestrator.test.ts, src/client/pages/activity/QualityComparisonPanel.test.tsx, src/client/pages/activity/ActivityPage.test.tsx, src/client/pages/activity/DownloadCard.test.tsx]
issue: 40
date: 2026-03-20
---
When extending `QualityDecisionReason` / `QualityGateData` with new non-optional fields (even nullable ones with `string | null`), TypeScript will flag every inline fixture object that doesn't include them. The blast radius is predictable from a grep for the type name in test files — do that grep before writing a single line of implementation so you know upfront which test files need updating. Using `replace_all: true` in Edit for the fixture pattern (e.g., `holdReasons: []` → `holdReasons: [], existingNarrator: null, ...`) is faster than manually touching each occurrence.
