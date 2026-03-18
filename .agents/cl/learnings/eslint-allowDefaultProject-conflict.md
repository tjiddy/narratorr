---
scope: [core]
files: [eslint.config.js, scripts/tsconfig.json]
issue: 312
date: 2026-03-08
---
When `scripts/tsconfig.json` exists with `"include": ["./**/*"]`, ESLint's `allowDefaultProject: ['scripts/*.ts']` conflicts — files are found in both the project service and the default project list. Fix: remove `allowDefaultProject` entirely since `projectService: true` picks up `scripts/tsconfig.json` automatically.
