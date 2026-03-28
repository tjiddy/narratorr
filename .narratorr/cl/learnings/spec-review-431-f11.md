---
scope: [scope/backend]
files: [src/server/utils/import-side-effects.ts]
issue: 431
source: spec-review
date: 2026-03-17
---
Reviewer caught that fire-and-forget inventory missed 2 notification calls in import-side-effects.ts (notifyImportComplete and notifyImportFailure). The original /elaborate only found 3 instances but there are 5. Prevention: grep for ALL instances of the pattern across the full src/server/ tree, not just the files mentioned in the issue body.
