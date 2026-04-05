---
scope: [backend, frontend]
files: [src/shared/schemas/blacklist.test.ts, src/client/lib/api/blacklist.ts, src/server/utils/rejection-helpers.ts]
issue: 321
source: review
date: 2026-04-05
---
Reviewer caught that type-only imports (import type { BlacklistReason }) have no runtime assertion — if a consumer reverts to a local union, tests still pass. The fix is compile-time type assertions using `AssertExact<T, U>` pattern in test files. For DRY-1 refactors that centralize types, add compile-time assertions that consumer types remain exactly equal to the canonical type. This is a test gap the explore subagent should flag when the spec says "derived from canonical definition."
