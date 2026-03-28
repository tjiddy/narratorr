---
scope: [infra]
files: [scripts/block.ts, scripts/resume.ts, scripts/merge.ts]
issue: 323
date: 2026-03-09
---
`blocked` is now a standalone flag (not `status/blocked`). This preserves the underlying status when an issue is blocked — `resume.ts` just removes the `blocked` flag instead of having to guess the previous status. All scripts that check blocked state now use `labels.includes("blocked")` instead of checking for `status/blocked`.
