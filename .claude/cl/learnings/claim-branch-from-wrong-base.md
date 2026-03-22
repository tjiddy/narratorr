---
scope: [backend, frontend]
files: [scripts/claim.ts]
issue: 57
date: 2026-03-22
---
If the working directory is on a feature branch (not main) when `/claim` runs, the new branch is forked from that feature branch instead of main. `git diff main` then shows both the old branch's commits AND the new ones, causing the self-review and coverage agents to analyze the wrong files. Always verify `git diff main --name-only` after claiming to confirm only the expected source files are in the diff. If stale commits appear, check `git log --oneline main..HEAD` — the branch may be correctly rooted on main's latest squash but the stash/checkout sequence during verify left HEAD on a different branch.
