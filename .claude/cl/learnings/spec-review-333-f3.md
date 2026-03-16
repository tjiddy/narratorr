---
scope: [scope/backend, scope/frontend]
files: [src/server/routes/system.ts, src/client/lib/api/system.ts]
issue: 333
source: spec-review
date: 2026-03-10
---
Spec said "API endpoint exposes update status" as an AC without defining the exact response shape. When backend and frontend must converge on a contract, the spec needs the literal JSON schema — field names, types, optionality, and how "absent" is represented (omit vs null). Vague AC like "exposes X" lets backend and frontend invent different contracts.
