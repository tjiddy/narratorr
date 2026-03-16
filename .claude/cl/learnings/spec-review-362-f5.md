---
scope: [scope/frontend]
files: []
issue: 362
source: spec-review
date: 2026-03-13
---
Reviewer caught that AC used "All X" language for low-priority cleanups (L-30, L-31) while Scope Boundaries said the cleanup was "representative, not exhaustive." The contradiction makes it impossible to know when the AC is satisfied. The fix: for cleanup/chore issues, always enumerate the exact files and instance counts in the AC. If the scope is limited, the AC must reference the specific listed files, not use "all" language.
