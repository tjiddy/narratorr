---
scope: [scope/backend, scope/frontend]
files: []
issue: 331
source: spec-review
date: 2026-03-10
---
User Interactions section said restore should "error when original path no longer exists" while the test plan said "parent directories created with mkdir recursive." These are contradictory behaviors. The gap came from writing the User Interactions section with a conservative mental model (fail-safe) and the test plan with a pragmatic one (recreate parents). Prevention: when writing restore/undo behavior, explicitly define what "path doesn't exist" means — missing parents vs. occupied destination are different failure modes requiring different responses.
