---
scope: [scope/frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 17
source: review
date: 2026-03-20
---
When an integration test verifies that component A passes a renamed/changed prop to component B, the mock data must have the old and new fields set to *different* values so the test can only pass if the correct field is used. In this case, the renamed prop (`envBypass` replacing `bypassActive` as the button gate) was tested with both fields set to the same boolean value — `bypassActive: true, envBypass: true` — so the test would pass even if the production code still used the old field. The fix: set `bypassActive: false, envBypass: true` in the initial mock, forcing the test to fail if the wiring is wrong.

This is the "diverging values" pattern for prop-rename wiring tests: the whole point of a wiring test is to prove which field is used, not just that the behavior works given a matching state.
