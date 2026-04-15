---
scope: [frontend]
files: [src/client/pages/manual-import/PathStep.test.tsx]
issue: 562
source: review
date: 2026-04-15
---
Reviewer caught PathStep.test.tsx mocking PathInput (child component) instead of mocking at the API boundary. The plan comment suggested mocking PathInput, but the project testing standard (testing.md:23) explicitly forbids child mocking. The fix was to render the real PathInput, mock `api.browseDirectory`, and test fallbackBrowsePath by opening the Browse modal and asserting the API was called with the forwarded path. Prevention: /plan should cross-check proposed test approaches against testing.md mock rules before suggesting child mocking.
