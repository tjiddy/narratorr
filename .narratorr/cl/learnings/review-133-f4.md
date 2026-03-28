---
scope: [backend, api]
files: [src/server/routes/books.test.ts]
issue: 133
source: review
date: 2026-03-26
---
When a PR adds a field to a service's return value, the route integration test must also be updated to assert that field is present in the HTTP response. Service-level tests cover business logic; route tests cover HTTP serialization (schema, field inclusion). A field that exists in the service but is stripped by the route schema or missed in serialization would only be caught at the route boundary. Always update route tests when service return shapes change.
