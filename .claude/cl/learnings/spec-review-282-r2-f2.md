---
scope: [scope/frontend, scope/api]
files: [src/shared/schemas/book.ts]
issue: 282
source: spec-review
date: 2026-03-10
---
Spec used UI label "owned" as the API payload status literal, but `BookStatus` only accepts `wanted|searching|downloading|importing|imported|missing|failed`. When a UI label differs from the persisted enum value, the spec must explicitly state the mapping (e.g., "UI label 'Owned' sends `status: 'imported'`") to prevent implementers from sending invalid payloads that fail schema validation.
