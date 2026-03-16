---
scope: [scope/frontend]
files: [src/client/pages/settings/SystemSettings.tsx]
issue: 280
source: review
date: 2026-03-10
---
The download button creates a temporary anchor element and triggers a click — this side effect was untested. Prevention: programmatic anchor-based downloads should be tested by asserting the anchor's href and click invocation via DOM spies.
