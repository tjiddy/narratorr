---
scope: [scope/backend]
files: [src/server/services/discovery.service.ts]
issue: 448
source: spec-review
date: 2026-03-18
---
Spec cited discovery.service.ts as "518 lines" but the reviewer clone showed 459 lines. Line counts drift between clones due to PRs merged at different times.

Root cause: Citing exact line counts in specs creates a fragile claim. The relevant fact is that the file exceeds the ESLint limit (400 lines) and has an eslint-disable suppression -- this is verifiable regardless of the exact count.

Prevention: In specs, reference the constraint violation (e.g., "exceeds the 400-line ESLint limit, suppressed with eslint-disable") rather than the current measurement. The goal is the constraint, not the number.
