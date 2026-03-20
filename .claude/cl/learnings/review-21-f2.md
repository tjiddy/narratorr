---
scope: [backend]
files: [src/server/server-utils.test.ts, src/server/plugins/security-plugins.ts]
issue: 21
source: review
date: 2026-03-20
---
When a plugin affects a cross-cutting concern (e.g., response headers), ALL existing integration test helpers that build apps with the related plugins must be updated to include the new plugin. server-utils.test.ts `createAppWithHelmet` only had helmet, not cspNonceStripPlugin — so the real HTML-serving path was tested without the production security stack. Updating the helper + adding a dedicated test for the combined behavior catches regressions in the full request flow.
