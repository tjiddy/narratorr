---
scope: [scope/frontend]
files: [src/client/App.tsx, src/client/App.test.tsx]
issue: 367
source: review
date: 2026-03-16
---
New `/discover` route was added to App.tsx but no corresponding route-wiring test was added in App.test.tsx. The existing test file had tests for every other route except the new one. Prevention: when adding a new route to App.tsx, always add a corresponding route-level test that renders the app at the new path and asserts the page component appears.
