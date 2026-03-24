---
scope: [scope/frontend, scope/backend]
files: [src/client/lib/api/discover.ts, src/db/schema.ts, src/shared/schemas/discovery.ts]
issue: 448
source: spec-review
date: 2026-03-18
---
Round 1 fix for SuggestionRow contract defined all timestamp fields as string | null, but refreshedAt and createdAt are required (non-null) in both the DB schema (NOT NULL with defaults) and the client interface. The spec introduced a nullability regression that would have changed the API contract.

Root cause: When defining the shared type, I generalized all timestamp fields as nullable without reading the actual client interface field-by-field. The client at discover.ts:21 has refreshedAt: string (required) and discover.ts:24 has createdAt: string (required).

Prevention: When defining shared types that replace existing contracts, copy field types verbatim from the current consumer (client interface), then verify each against the DB schema. Do not generalize nullability -- match exactly.
