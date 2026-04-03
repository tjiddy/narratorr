---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx, src/client/components/settings/IndexerFields.test.tsx]
issue: 317
source: review
date: 2026-04-03
---
The primary new UX feature (blur-triggered VIP detection with modal, badge, refresh, error states) had zero component-level interaction tests. The existing test file only covered field presence and language toggles. When adding async UI behavior (blur → API → badge), always add interaction tests that mock the API and assert the full flow: empty input skips call, valid input shows badge on success, failure shows error, and refresh triggers re-detection. This was flagged as a coverage gap in the handoff subagent but wasn't fixed.
