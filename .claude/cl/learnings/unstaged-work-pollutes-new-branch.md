---
scope: [frontend, backend]
files: []
issue: 175
date: 2026-03-28
---
Uncommitted (unstaged) working tree changes from one feature branch remain in the working tree when /claim creates a new branch. it.todo() stubs for issue #176 were in the working tree from a prior session; they appeared in git diff main --name-only on the #175 branch and triggered the stub-check gate. The fix: git restore <file> before handoff. Prevention: always commit or stash in-progress work before starting a new issue via /implement.
