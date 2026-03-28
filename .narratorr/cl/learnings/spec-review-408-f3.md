---
scope: [scope/backend, scope/api]
files: []
issue: 408
source: spec-review
date: 2026-03-17
---
The snooze endpoint was specified with error cases (400/404/409) but no success response contract — no status code, no response body shape. The reviewer noted that existing discover routes return different shapes (dismiss returns a row, add returns a composite object), so the payload type couldn't be inferred. Root cause: the spec defined the endpoint by its validation/error behavior but forgot to define the happy path contract. Would have been caught by requiring every new route AC to specify: method, path, request body schema, success status code, and success response shape.