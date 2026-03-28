---
scope: [scope/frontend, scope/ui]
files: [src/client/components/Button.tsx, src/client/components/Button.test.tsx]
issue: 162
source: review
date: 2026-03-28
---
Testing that a loading spinner replaces an icon requires asserting (1) the spinner is present via its testid, and (2) exactly one svg exists (or the original icon testid is absent). Checking only that an svg exists does not prove replacement — the icon could be supplemented. Use querySelectorAll(svg).length === 1 to catch supplement-vs-replace regressions.
