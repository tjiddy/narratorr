---
scope: [scope/frontend, scope/ui]
files: [src/client/components/layout/Layout.test.tsx, src/client/pages/settings/GeneralSettings.test.tsx]
issue: 157
source: review
date: 2026-03-27
---
The cache-invalidation wiring test in GeneralSettings.test.tsx only proved that getSettings was called again (proxy for invalidation), but never rendered Layout or asserted modal visibility. A bug that broke the Layout observer would pass this test while the AC failed.

Why: Stopped at the "cache refetch happened" layer instead of going all the way to "user-visible outcome (modal opens)".

What would have prevented it: When an action in Page A must produce a visible effect in Page B (Layout), the integration test must render both in the same QueryClientProvider with the same router tree. For cache-invalidation flows: render the triggering component and the consuming component together, then assert the consumer's visible state change.
