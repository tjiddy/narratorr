---
scope: [scope/services, scope/backend]
files: [src/server/services/auth.service.ts, src/server/services/auth.service.test.ts]
issue: 8
source: review
date: 2026-03-19
---
The `deleteCredentials()` test only asserted `db.delete` ran — it never checked what `setAuthConfig` persisted. If the auth-mode reset (`config.mode = 'none'`) was accidentally removed or changed, the test would still pass. The pattern from `initialize` tests (asserting `db.insert.mock.results[0].value.values.mock.calls[0][0]`) should be applied any time a service method mutates and re-persists config: assert the full shape of the persisted object (mode, preserved fields) not just that the insert happened.
