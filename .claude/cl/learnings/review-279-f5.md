---
scope: [backend]
files: [src/server/plugins/auth.plugin.test.ts]
issue: 279
source: review
date: 2026-03-10
---
Route tests using createTestApp() don't register the auth plugin, so they only prove happy-path serialization. Auth coverage needs a separate test in the auth plugin test file that verifies new routes return 401. Pattern: inject requests for each new route with no session cookie, assert 401.
