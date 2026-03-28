---
scope: [backend, frontend, services, ui]
files: [src/server/services/quality-gate-orchestrator.ts, src/client/pages/activity/QualityComparisonPanel.tsx]
issue: 40
date: 2026-03-20
---
When a feature has two overlapping conditions (here: `holdReasons.includes('unhandled_error')` AND `probeError === null`), always define the precedence in the spec before implementation. The `unhandled_error` heading rule takes precedence over the `probeError`-null fallback: if both apply (legacy event with `unhandled_error` and no `probeError`), show "Unexpected error" + generic body — NOT "Audio probe failed". This required two spec review rounds to nail down; define the priority ordering in the AC before starting.
