---
scope: [scope/backend]
files: [src/server/plugins/auth.ts, src/server/plugins/auth.plugin.test.ts]
issue: 8
source: review
date: 2026-03-19
---
When testing a cookie attribute change (e.g., `Secure: false`), every path that sets that cookie must be tested — not just the most obvious one. The login/logout cookie tests correctly asserted `Secure` absence, but the sliding-renewal cookie path in `auth.ts` was untested for the same attribute. Whenever a cookie-security change is made, grep all `setCookie` call sites and verify each has a test asserting the new attribute.
