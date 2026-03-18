---
scope: [scope/backend, scope/services]
files: [src/server/services/discovery.service.ts]
issue: 408
source: review
date: 2026-03-17
---
Resurfaced narrator suggestions were rescored using `authorName` to look up `narratorAffinity`, but the affinity map is keyed by narrator name. For multi-reason suggestion types where the affinity key differs from authorName (narrator, potentially others), the resurfacing path must resolve the correct lookup key based on `reason`. Missed because the initial implementation only tested the author-based resurfacing path, and the `getStrengthForReason` method's parameter was named `authorName` which made the wrong usage look correct.
