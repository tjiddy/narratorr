---
scope: [scope/backend]
files: []
issue: 407
source: spec-review
date: 2026-03-17
---
Reviewer caught a test plan referencing `computeResurfacedScore()` which doesn't exist in the codebase. Root cause: named the method from memory / intent rather than verifying with a grep. Every method name referenced in a test plan should be verified against the actual codebase before submission. A `rg functionName src/` check would have caught this instantly.
