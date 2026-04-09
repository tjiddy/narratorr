---
scope: [infra]
files: [scripts/lib.ts, scripts/verify.ts]
issue: 434
date: 2026-04-08
---
The diff-based lint gate in verify.ts compares violations by exact `file|rule|line|column|message`. For file-level rules like `max-lines`, adding even one line shifts the violation's line number AND message text ("402" vs "401"), making it appear as a "new" violation even though the file was already over the limit on main. The fix is to ensure net-zero line changes when modifying files that are already at the max-lines boundary.
