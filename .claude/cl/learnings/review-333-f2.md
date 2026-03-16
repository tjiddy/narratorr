---
scope: [backend]
files: [src/server/plugins/auth.plugin.test.ts, src/server/routes/update.ts]
issue: 333
source: review
date: 2026-03-10
---
Reviewer flagged that the dismiss endpoint's private-route auth contract was untested. The existing auth tests only used generic `/api/test` but never named the real dismiss endpoint. Missed because "it follows the standard pattern" felt sufficient — but if someone accidentally added it to the public whitelist, no test would catch it. Lesson: new private endpoints need explicit auth tests, even when they follow the standard pattern.
