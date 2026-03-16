---
scope: [scope/frontend]
files: []
issue: 339
source: spec-review
date: 2026-03-11
---
Test plan included `--repeat=10` flag for Vitest which doesn't exist in Vitest 4.x. The spec assumed a CLI feature without verifying it works against the pinned version. Always verify CLI flags against the actual installed tool version before including them in test plans or AC.
