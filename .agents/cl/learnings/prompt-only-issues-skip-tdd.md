---
scope: [type/chore]
files: [.claude/skills/implement/SKILL.md, .claude/skills/plan/SKILL.md, .claude/skills/respond-to-pr-review/SKILL.md]
issue: 352
date: 2026-03-14
---
Issues that only modify skill prompt files (.md) don't follow the red/green TDD cycle — there are no automated tests for prompt behavior. The /implement flow still works but the test stub, coverage review, and test depth steps are all N/A. The handoff self-review and manual integrity check are the primary quality gates instead.
