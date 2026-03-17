---
scope: [scope/infra]
files: []
issue: 412
source: spec-review
date: 2026-03-16
---
AC3 prescribed specific resolution commands (`git checkout --theirs`, `git add`) but the scope note expanded detection beyond `UU` to states where `--theirs` doesn't apply. The gap: when broadening detection scope, the corresponding user-facing guidance must be re-evaluated against all the new states. Status-agnostic guidance is safer than prescriptive commands.
