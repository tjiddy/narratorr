---
scope: [scope/backend]
files: []
issue: 407
source: spec-review
date: 2026-03-17
---
Reviewer caught that the spec said to add `'diversity'` to "schema, shared types, client type" but no shared discover type exists in `src/shared/`. The actual caller surface spans 8 files across backend (schema, service, routes) and frontend (API types, page filters). A vague enum bullet would have led to incomplete implementation.

Root cause: Assumed a shared type surface existed without grepping `src/shared/` for discover artifacts. Also didn't enumerate the full caller surface — just gestured at "schema and types" without listing concrete files.

Prevention: For any enum/type extension, grep the codebase for all current usages of the existing literals and list every file that needs updating in the spec. Don't assume shared types exist — verify.
