---
scope: [scope/backend]
files: []
issue: 406
source: spec-review
date: 2026-03-17
---
Blast radius guidance said `.default({})` for the new `weightMultipliers` field, but AC4 declared the type as `Record<SuggestionReason, number>` and the inspectability story depended on `GET /api/settings` returning a full record. The empty default would break both contracts until the first refresh. Prevented by: when a spec fix introduces a schema default, verify it satisfies every consumer of that field (type contract, API response shape, inspectability claims).
