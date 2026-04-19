---
scope: [workflow]
files: [scripts/block.ts, scripts/claim.ts, .claude/skills/implement]
issue: 653
date: 2026-04-19
---
When `/implement` is interrupted by `scripts/block.ts` (e.g. a pre-existing env failure in `scripts/verify.ts`) and the user re-runs `/implement <id>` later, the local feature branch and all in-session commits are gone — you land back on `main` with the work lost. Plan for restart-from-scratch: the prior plan comment and issue labels persist, but every file edit has to be redone. If a retry is likely, push the branch early (before the first verify gate) so at least the commits survive on the remote, OR just accept the re-do cost for small diffs. The stop-gate state dir (`.narratorr/state/implement-<id>/`) is also wiped, so phase markers need re-writing on each retry.
