---
scope: [infra]
files: [scripts/claim.ts]
issue: 341
date: 2026-03-12
---
When a branch already exists from a prior implementation attempt, `claim.ts` fails with `fatal: a branch named '...' already exists`. The script doesn't handle this case — you have to manually `git checkout` to the existing branch and update labels. Consider adding a `--resume` flag to claim.ts or handling existing branches gracefully.
