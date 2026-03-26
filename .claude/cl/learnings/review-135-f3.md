---
scope: [backend, frontend, api]
files: [src/server/services/bulk-operation.service.ts, src/client/lib/api/bulk-operations.ts, src/client/hooks/useBulkOperation.ts]
issue: 135
source: review
date: 2026-03-26
---

`BulkJobStatus` used `id: string` instead of the spec-approved `jobId: string`. The `GET /api/books/bulk/active` and `GET /api/books/bulk/:jobId` responses serialized as `{ id, ... }`, but the approved contract is `{ jobId, ... }`. Any client expecting `jobId` would silently fail to resume polling.

Root cause: When designing the service, `id` was used as the natural primary field name without checking the spec's prescribed field name for the serialized response. The POST start endpoints correctly returned `{ jobId }`, creating an inconsistency.

What would have caught it: Cross-checking the `GET /active` response shape against the spec before writing the `BulkJobStatus` interface. The test fixtures used `{ id: 'job-1', ... }` without comparing to the spec contract, so the mismatch was invisible.

Prevention: When a spec defines an API response shape with named fields, copy the field names verbatim into the interface before implementing. Run a "field name cross-check" as part of the spec review: for each endpoint response, verify every spec-named field matches the type definition.
