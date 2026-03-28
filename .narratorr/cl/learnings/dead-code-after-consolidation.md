---
scope: [backend]
files: [src/server/jobs/blacklist-cleanup.ts, src/server/jobs/index.ts]
issue: 332
date: 2026-03-10
---
When consolidating a standalone job into another (e.g., blacklist-cleanup into housekeeping), the old file and its test must be deleted — not just the import. Self-review caught this as dead code. Always `git rm` the old files when replacing, not just removing the import.
