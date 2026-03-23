---
scope: [backend]
files: [src/server/routes/discover.test.ts, src/server/routes/prowlarr-compat.test.ts]
issue: 57
date: 2026-03-23
---
Auth integration tests that spin up a real Fastify app with the auth plugin will silently pass through (returning 200 or 500 instead of 401) when `AUTH_BYPASS=true` is set in the test environment. The fix is to add `vi.mock('../config.js', () => ({ config: { authBypass: false, isDev: true } }))` at the top of the test file (before other imports) — the same pattern used in `auth.plugin.test.ts`. Without this mock, the auth plugin reads the real config and bypasses the auth check, so the test never exercises the 401 path. This was a pre-existing failure on main; the fix was applied, reverted (reason unknown), and then re-applied during #57 handoff.
