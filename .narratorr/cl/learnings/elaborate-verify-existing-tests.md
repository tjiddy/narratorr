---
scope: [frontend]
files: [src/client/lib/api/api-contracts.test.ts, src/client/lib/api/backups.test.ts]
issue: 478
date: 2026-04-11
---
Elaboration initially claimed `api-contracts.test.ts` didn't exist and proposed creating per-module test files. The centralized contract suite was already in place. Always `git ls-files` or grep for existing test files before proposing new ones in elaboration — false negatives in codebase exploration waste a full spec review round-trip.
