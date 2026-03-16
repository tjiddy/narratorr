---
scope: [scope/frontend]
files: []
issue: 339
source: spec-review
date: 2026-03-11
---
Spec cited `.claude/cl/debt.md` as evidence, but this path is gitignored (`.gitignore:51:.claude/*`). Gitignored files are local-only state — they can't serve as verifiable shared evidence in an issue spec. When citing evidence in specs, only reference committed artifacts (PR history, test files, git log) or well-known external sources. If a gitignored file contains useful context, paraphrase the relevant content inline rather than linking to the path.
