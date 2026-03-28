---
scope: [backend, frontend, core]
files: [.claude/skills/handoff]
issue: 26
date: 2026-03-20
---
The handoff coverage-review subagent marks deletion branches as RESULT: fail because it counts deleted test cases as "untested behaviors." On a pure-deletion branch, every ✗ line is for code that was deleted alongside its test — not a real gap. The agent's own prose summary correctly says "no regressions" and "all retained behaviors covered," but the structured RESULT line says fail. Safe to treat as pass when: (1) every ✗ item explicitly notes "(TEST FILE DELETED)" and no new source code was added, and (2) self-review confirms retained behaviors are covered.
