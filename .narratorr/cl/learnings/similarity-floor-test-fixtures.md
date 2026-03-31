---
scope: [backend]
files: [src/server/services/match-job.service.ts, src/server/services/match-job.service.test.ts]
issue: 235
date: 2026-03-31
---
Adding a title similarity floor (< 50% → confidence 'none') breaks existing tests that use generic fixture titles like 'Book A' or 'Book B' when the sample candidate is 'The Way of Kings'. These low-similarity titles now get 'none' instead of 'medium'/'high'. When adding any scoring/similarity gate, audit all existing test fixtures for title alignment — 13 tests broke because of mismatched fixture titles. Fix: update fixture titles to match the candidate title or be sufficiently similar.
