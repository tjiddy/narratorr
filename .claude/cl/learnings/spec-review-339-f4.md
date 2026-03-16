---
scope: [scope/frontend]
files: []
issue: 339
source: spec-review
date: 2026-03-11
---
AC4 had two contradictory pass thresholds ("12 passing runs" vs "run 3x in CI or locally"). When an AC item references a verification procedure, state the threshold exactly once with a single number. Parenthetical alternatives create ambiguity about which is the actual gate.
