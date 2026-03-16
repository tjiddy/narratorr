---
scope: [frontend]
files: [src/client/components/layout/Layout.test.tsx]
issue: 279
source: review
date: 2026-03-10
---
Same as F6 but for layout-level wiring. HealthIndicator tested standalone but deleting it from Layout would fail no test. Added a Layout test that mocks getHealthSummary to return 'error' and asserts the health-indicator testid appears. Applies to any component wired into the global app shell.
