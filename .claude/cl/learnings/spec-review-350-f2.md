---
scope: [scope/backend, scope/services]
files: []
issue: 350
source: spec-review
date: 2026-03-14
---
Spec review caught a reference to `debt-scan-findings.md` — a file that doesn't exist in the repo. The spec was written from manual debt scan notes and cited the source without verifying the file was committed. /elaborate should verify all file paths referenced in the spec body actually exist before writing them into the issue.
