---
scope: [scope/backend]
files: [src/server/services/metadata.service.ts, src/server/services/metadata.service.test.ts]
issue: 437
source: review
date: 2026-03-18
---
Reviewer caught that the constructor's config forwarding to registry factories was untested. The registry test proved the factory works when called manually, but not that MetadataService actually passes the right config. Prevention: when adding indirection (service → registry → factory), test the wiring at the service level too, not just the factory in isolation.
