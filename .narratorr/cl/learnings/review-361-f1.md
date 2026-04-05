---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.test.tsx]
issue: 361
source: review
date: 2026-04-05
---
When testing that a function reads live form state (watch()), asserting default values proves nothing — the test passes even if the code uses a stale snapshot. Must mutate the form fields before triggering the action, then assert the mutated values appear in the API payload. This is especially important when the spec explicitly calls out "honoring unsaved edits."
