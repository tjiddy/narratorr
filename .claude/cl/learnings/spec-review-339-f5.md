---
scope: [scope/frontend]
files: [src/client/__tests__/crud-settings-helpers.ts, src/client/pages/settings/NotificationsSettings.test.tsx]
issue: 339
source: spec-review
date: 2026-03-11
---
Pattern C test plan listed only 2 of 3 consumers of the crud-settings-helpers dialog button selector. When changing a shared helper, grep for all imports/consumers and include them all in the regression check — don't rely on memory of "the main ones".
