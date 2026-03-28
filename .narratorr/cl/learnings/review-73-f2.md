---
scope: [scope/frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 73
source: review
date: 2026-03-24
---
Same pattern as review-73-f1: downstream behavior tests (disabled state, opacity, re-enable) for the Keep Original toggle survive a regression to a visible raw checkbox. The compact slider variant (w-9 h-5) conversion AC requires a dedicated test asserting `sr-only` class on the checkbox and presence of the slider-track div with compact sizing classes. Behavioral coverage alone is not sufficient when the AC specifies a markup pattern — the pattern itself must be the test subject.
