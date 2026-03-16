---
scope: [backend]
files: [apps/narratorr/src/server/services/tagging.service.ts]
issue: 277
source: review
date: 2026-03-06
---
Reviewer caught that `unlink(original)` before `rename(tmp, original)` creates a data-loss window — if rename fails after delete, the original file is gone. On POSIX, `rename()` atomically overwrites the destination, so the unlink is unnecessary. The fix was removing the unlink call entirely. This was missed because the temp-file pattern was coded from a "write tmp → delete old → move tmp" mental model instead of the correct "write tmp → rename over old" pattern. Would have been caught by a test that simulates rename failure.
