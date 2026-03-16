---
scope: [scope/db, scope/api]
files: [src/db/schema.ts, src/shared/schemas/blacklist.ts, src/client/lib/api/blacklist.ts]
issue: 365
source: spec-review
date: 2026-03-15
---
Spec review caught that L-4 (blacklist.reason NOT NULL) only addressed the DB constraint without tightening the public API contract. `createBlacklistSchema` and `blacklistApi.addToBlacklist()` both allow omitting `reason`, and the UI renders missing reasons as "Unknown". Adding NOT NULL at the DB level without updating the Zod schema, API client, and defining a backfill policy would cause runtime failures on manual blacklist creates.

Root cause: `/elaborate` checked service call sites (which all provide reason) but didn't check the public input schemas or client API types. The assumption "every call site provides a reason" was true for internal code but false for the external-facing contract.

Prevention: When a spec proposes tightening a DB constraint, always trace the full write path from UI → API client → Zod schema → route → service → DB. If any layer allows the value to be optional, the spec must define what happens at each layer.
