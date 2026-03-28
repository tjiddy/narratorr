---
scope: [core]
files: [scripts/lib.ts]
issue: 268
date: 2026-03-09
---
Node.js 20 cannot execute `.ts` files directly — `ERR_UNKNOWN_FILE_EXTENSION`. The `scripts/lib.ts` helper used `execFileSync("node", ...)` to run `gitea.ts`, which fails. Must use `tsx` instead. This broke all workflow scripts until fixed.
