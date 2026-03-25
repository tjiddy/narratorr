---
scope: [backend]
files: [src/server/services/library-scan.service.ts]
issue: 104
date: 2026-03-25
---
When a copy/move operation needs to guard against source === destination (e.g., library self-import), always use `path.resolve()` on both sides before comparing — not a string equality check on raw paths. Raw paths can diverge due to trailing slashes, relative segments, or symlinks even when they point to the same location. `resolve(a) === resolve(b)` is the correct guard. Add it as a guard clause before any `mkdir`/`cp`/`rm` sequence, not at the caller level, so the protection travels with the function.
