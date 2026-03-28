---
scope: [core]
files: [eslint.config.js]
issue: 268
date: 2026-03-09
---
ESLint with typescript-eslint's `allowDefaultProject` has a default limit of 8 files. When more than 8 scripts match the glob, it errors with "Parsing error: Too many files have matched the default project." Fix by setting `maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING` to a higher value in `parserOptions.projectService`.
