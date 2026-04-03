---
scope: [frontend]
files: [src/client/pages/settings/BackupTable.tsx, src/client/pages/settings/SystemSettings.tsx]
issue: 313
source: review
date: 2026-04-03
---
The spec review suggested global button disable during mutation (F6), but the issue's user interactions section explicitly says "clicking a second backup while first is validating replaces the pending selection." The suggestion was treated as the final word when it should have deferred to the issue's interaction spec. Always re-read the issue body after incorporating review suggestions to verify no conflict was introduced.
