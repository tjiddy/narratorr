---
scope: [scope/backend]
files: [src/server/config.ts]
issue: 284
source: spec-review
date: 2026-03-09
---
Spec had contradictory error handling for invalid URL_BASE — said both "rejected or normalized" and "falls back to `/` with warning". The existing config pattern is fail-fast (Zod safeParse + throw). When adding new env vars to the config, always match the existing error contract — don't introduce a second error handling style.
