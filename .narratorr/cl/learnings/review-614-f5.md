---
scope: [infra]
files: [e2e/README.md, e2e/global-setup.ts]
issue: 614
source: review
date: 2026-04-17
---
Mid-implementation I discovered Playwright's `globalSetup` env doesn't propagate to worker processes and fixed the spec code — but left the README and globalSetup comments describing the OLD (broken) pattern. Future authors would hit the same trap. Lesson: when a discovered-mid-implementation constraint changes the code, the docs and comments that described the old approach must be updated in the SAME commit. Grep for the pattern you just abandoned across README/CLAUDE.md/inline comments before pushing.
