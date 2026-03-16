---
scope: [backend]
files: [src/server/plugins/auth.ts, src/server/plugins/auth.plugin.test.ts]
issue: 382
source: review
date: 2026-03-15
---
Reviewer caught that the new Basic auth early-reject tests only asserted status code and "not called", but not the response body or www-authenticate header. The new branch returns `{ error: 'Invalid credentials' }` with a challenge header — if it returned a different error message or omitted the header, the tests would still pass. Fix: assert the full observable contract (status + headers + body) not just the status code. This is especially important for security-related response changes where the exact error message matters.
