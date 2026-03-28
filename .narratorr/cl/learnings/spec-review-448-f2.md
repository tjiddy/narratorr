---
scope: [scope/frontend, scope/backend]
files: [src/shared/schemas/discovery.ts, src/client/lib/api/discover.ts, src/server/services/discovery.service.ts]
issue: 448
source: spec-review
date: 2026-03-18
---
Spec said "derive SuggestionRow from shared schema" but did not define the shared artifact, the serialization boundary (DB Date vs API ISO string), or the migration path. The reviewer correctly flagged that src/shared/schemas/discovery.ts only defines SuggestionReason -- there is no row type to derive from.

Root cause: The /elaborate skill identified the type duplication (DRY-1) but did not follow through to define the solution contract. "Derive from shared schema" is a direction, not a spec. For any "eliminate duplication" item, the spec must name: (1) the new single source of truth artifact, (2) what it models (DB row vs API response vs wire format), (3) how each consumer migrates to it.

Prevention: Add to /elaborate step 4 gap-fill: "For DRY-1 findings (type duplication), the spec must define the shared artifact name, which layer it models (DB/API/wire), and the consumer migration path."
