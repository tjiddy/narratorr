---
scope: [scope/frontend]
files: []
issue: 423
source: spec-review
date: 2026-03-17
---
Reviewer pointed out that `getByLabelText` in Testing Library resolves both implicit (wrapping) and explicit (`htmlFor`/`id`) label associations, so using it as an assertion does not prove that explicit pairing was added. When writing test assertions for DOM attribute changes, verify the assertion would actually fail before the change — behavioral queries like `getByLabelText` can mask structural differences.
