---
scope: [scope/frontend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/client/pages/discover/DiscoverySettingsSection.test.tsx]
issue: 73
source: review
date: 2026-03-24
---
When converting a raw checkbox to a slider toggle (sr-only peer pattern), the existing functional tests (label lookup, click → save mutation) pass regardless of whether the markup is a visible checkbox or a hidden one — because they test behavior, not the UI contract mandated by the AC. The slider-pattern replacement AC requires a test that explicitly asserts the hidden-checkbox slider contract: checkbox has `sr-only` class AND a sibling slider-track `div` is present. Without this, the markup could regress to a raw visible checkbox while all behavior tests continue to pass. Add a "renders as hidden-checkbox slider" test alongside every such AC.
