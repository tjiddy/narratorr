---
scope: [backend]
files: [src/server/routes/auth.test.ts, src/server/routes/auth.ts]
issue: 8
date: 2026-03-19
---
When fixing a bug by inverting existing behavior (e.g., removing `Secure` cookie flag), an existing test that asserted the OLD wrong behavior must be renamed and inverted, not just removed. Found a test "logout cookie includes Secure flag in production mode" that was testing exactly the behavior we were fixing. Renamed it to "login and logout cookies never include Secure flag" and inverted assertions. Check for existing tests that validate the bug before writing new tests.
