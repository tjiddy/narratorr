---
scope: []
files: []
issue: 365
source: spec-review
date: 2026-03-15
---
Spec review caught that the source artifact reference (`debt-scan-findings.md`) doesn't exist in the repository. The file was either external/transient from the original debt scan or was never committed.

Root cause: `/elaborate` preserved the source reference from the original issue body without verifying the file exists with `git ls-files` or `ls`.

Prevention: When a spec references a source artifact by filename, verify it exists in the repo before including it. If it doesn't exist, point to the closest in-repo equivalent (e.g., `.claude/cl/debt.md`).
