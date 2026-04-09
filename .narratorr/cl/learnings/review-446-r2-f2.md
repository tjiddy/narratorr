---
scope: [backend]
files: [src/server/plugins/auth.plugin.test.ts]
issue: 446
source: review
date: 2026-04-09
---
When adding a new API endpoint, always add the path to the auth plugin test's "protected routes" list in `auth.plugin.test.ts`. The route test file uses `createTestApp()` which omits the auth plugin, so route-level tests can never prove auth is enforced. The auth plugin test is the only place that verifies path-specific protection.
