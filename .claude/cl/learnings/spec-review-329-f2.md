---
scope: [type/chore, scope/infra]
files: [package.json]
issue: 329
source: spec-review
date: 2026-03-11
---
The spec said "upgrade all npm dependencies to latest" in the title/summary but the AC only listed a subset of majors, creating an ambiguous completion rule. For upgrade issues, always define an explicit completion rule: "upgrade every direct dep to latest except these enumerated deferrals" — not a vague "all" with implicit exceptions.
