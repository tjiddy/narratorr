---
scope: [scope/frontend]
files: [src/client/pages/library/LibraryToolbar.tsx]
issue: 364
source: spec-review
date: 2026-03-14
---
AC offered "context or grouped prop objects" as alternatives but then said "without LibraryToolbar acting as a prop pass-through" — which rules out the grouped-props option. Root cause: the round 1 fix correctly identified both viable solutions but wrote a single AC item that applied the constraint of one approach (context) to both options. When AC offers multiple acceptable approaches, each must have its own success criteria stated separately.
