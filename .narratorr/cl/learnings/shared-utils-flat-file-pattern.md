---
scope: [backend, frontend]
files: [src/shared/error-message.ts, src/shared/parse-word-list.ts, src/shared/constants.ts]
issue: 513
date: 2026-04-12
---
`src/shared/utils.ts` already exists as a flat file, so `src/shared/utils/` cannot be created as a directory alongside it. New shared utilities must use individual flat files at the `src/shared/` root (e.g., `src/shared/error-message.ts`). This was caught during spec review and would have blocked implementation if discovered mid-work.
