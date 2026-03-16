---
scope: [infra]
files: [.claude/skills/handoff/SKILL.md]
issue: 353
source: spec-review
date: 2026-03-14
---
Spec listed `root/**` as an infra trigger pattern, but this repo has no `root/` directory at the repo root. The Docker s6-overlay files live under `docker/root/`. Root config files like `tsconfig.json`, `eslint.config.js`, `vite.config.ts` are at the repo root, not in a `root/` subdirectory. Fix: always verify trigger file patterns with `git ls-files` before including them in AC.
