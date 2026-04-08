---
scope: [core]
files: [src/core/utils/book-discovery.ts, src/core/utils/book-discovery.test.ts]
issue: 426
source: review
date: 2026-04-08
---
Mixed-content folders (loose audio + subfolders) take a separate code path in `collectBooks()` that skips loose files before checking disc patterns. When extending disc detection to new patterns (titled-disc), the new tests only covered the pure-parent branch, not the mixed-content branch. The fix: when adding new detection patterns, trace all branches that reach the detection logic and add tests for each one — especially the mixed-content path which has historically had separate behavior.
