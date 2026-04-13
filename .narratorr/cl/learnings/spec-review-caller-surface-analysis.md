---
scope: [backend, frontend]
files: [src/server/services/metadata.service.ts, src/client/hooks/useAudnexusSearch.ts]
issue: 523
date: 2026-04-13
---
When a spec changes behavior on a shared API endpoint, the spec review will flag all consumers of that endpoint. For `GET /api/metadata/search`, three client hooks consume it: `useMetadataSearch` (search page), and `useAudnexusSearch` (BookMetadataModal, BookEditModal). Spec reviews caught this caller-surface gap twice — once in round 1 (missed) and once in round 2 (blocking). Future specs that modify shared endpoints should enumerate all consumers upfront to avoid review round-trips.
