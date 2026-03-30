---
scope: [frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx, src/client/pages/settings/ProcessingSettingsSection.test.tsx]
issue: 219
source: review
date: 2026-03-30
---
When replacing a Zod schema construct (z.preprocess) with a form-layer equivalent (setValueAs), every validation branch that the original construct provided must be re-tested through the new code path. The `.int()` constraint still existed in the schema, but the reviewer correctly noted that the new `setValueAs` parser now owns raw string-to-number conversion — if it ever silently rounded/truncated, `.int()` would never see the decimal. The test plan mentioned "non-integer value rejected" but the implementation only tested integer boundary values (0, 1), not actual decimal input. Missing test was caught because the spec test plan was treated as a checklist but the decimal case wasn't wired to a real assertion.
