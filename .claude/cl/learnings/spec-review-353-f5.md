---
scope: [infra]
files: [.claude/skills/handoff/SKILL.md, .claude/skills/plan/SKILL.md]
issue: 353
source: spec-review
date: 2026-03-14
---
Spec described trigger conditions for infra checks (W-6) and settings fixture scans (W-9) without listing the concrete trigger files. Reviewers and implementers can't verify or test subjective triggers like "root config, deps, or build artifacts." Fix: always translate abstract trigger descriptions into repo-specific file glob patterns in the AC.
