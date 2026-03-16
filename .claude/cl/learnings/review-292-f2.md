---
scope: [backend, infra]
files: [docker/s6-service.test.ts]
issue: 292
source: review
date: 2026-03-10
---
Tests that check file existence and content are insufficient for shell scripts that must be executable. Add a test using `git ls-tree HEAD` to verify the committed file mode is `100755`. This catches the exact defect that passed all other tests — the run script was present and correct but non-executable.
