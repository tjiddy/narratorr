---
scope: [scope/frontend, scope/api]
files: [src/client/pages/activity/QualityComparisonPanel.tsx, src/server/services/quality-gate.service.ts]
issue: 282
source: spec-review
date: 2026-03-10
---
Spec asked for "side-by-side current vs downloaded" comparison but the QualityGateData payload only has existingMbPerHour for the current side — duration, codec, and channels only have downloaded values or delta/flags. When speccing UI that shows data, read the actual DTO/payload to verify which fields are available for display rather than assuming both sides exist.
