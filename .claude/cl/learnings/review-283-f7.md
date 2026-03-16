---
scope: [backend]
files: [src/shared/schemas/sse-events.ts, src/server/jobs/monitor.ts, src/server/services/download.service.ts]
issue: 283
source: review
date: 2026-03-10
---
When fixing multiple files across context window boundaries, always verify ALL modified files are staged before committing. Git status at conversation start showed 3 files as unstaged modified (changes from the previous session), but the commit only `git add`'d the 7 new files explicitly. The 3 files carrying the critical F1 schema fix (restoring enum imports in sse-events.ts, type casts in monitor.ts and download.service.ts) were left behind. Root cause: not running `git status` before the commit to verify what was staged. Prevention: always `git status` before committing, especially when continuing from a previous session.
