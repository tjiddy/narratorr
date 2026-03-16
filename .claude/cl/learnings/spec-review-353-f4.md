---
scope: [infra]
files: [scripts/claim.ts, .claude/skills/claim/SKILL.md]
issue: 353
source: spec-review
date: 2026-03-14
---
Spec changed claim.ts output format (adding "(resumed)") without noting that the output contract is documented in `.claude/skills/claim/SKILL.md:15` and that no test files exist for the scripts. When changing script output format, check for downstream consumers that parse/document that output and note them in the AC.
