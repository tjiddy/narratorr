---
scope: [frontend, core]
files: [src/client/components/Modal.tsx, src/client/hooks/useConnectionTest.ts]
issue: 227
date: 2026-03-31
---
`git show main:` results can become stale if main is updated between checks. The spec review for #227 went through 4 rounds of circular disputes because both sides cached stale `git show main:` results. Always re-verify `git show main:` before asserting what exists on main, especially in long-running conversations.
