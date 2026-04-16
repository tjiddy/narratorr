---
scope: [infra]
files: [e2e/tsconfig.json]
issue: 614
date: 2026-04-16
---
Sub-project tsconfigs with `rootDir: "."` break on imports from parent (`../../src/db/*`) with `TS6059: File is not under rootDir`. Since e2e typecheck is `--noEmit`, rootDir is pointless (it only affects emit output structure). Remove `rootDir` entirely and add `../src/**/*.ts` to `include` so TS resolves the upstream files. Same treatment would apply to any future sibling tsconfig that imports from the main project.
