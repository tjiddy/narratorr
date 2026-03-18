---
scope: [scope/backend, scope/services]
files: [src/server/services/book-list.service.test.ts]
issue: 422
source: review
date: 2026-03-17
---
Reviewer caught that the schema-derived slim select (getTableColumns minus description/genres) had no service-level test proving the column contract. The AC said "derived from schema" but the test suite only covered the route forwarding `slim: true` — not the actual select fields. When a refactor changes HOW data is selected (e.g., from explicit column list to schema-derived), add a test asserting the resulting column set, not just that the option is forwarded.
