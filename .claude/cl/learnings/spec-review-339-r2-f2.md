---
scope: [scope/frontend]
files: []
issue: 339
source: spec-review
date: 2026-03-11
---
Test plan included bash-specific `for i in $(seq 1 10); do ... done` loops which aren't portable across shells. Test plan verification commands should either be single-command invocations (portable) or described as prose ("run X times consecutively") so the implementer applies their own looping. Avoid shell-specific syntax in specs — the implementer's shell may differ.
