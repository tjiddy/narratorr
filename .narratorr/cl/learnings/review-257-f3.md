---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx, src/client/pages/book/BookDetails.test.tsx]
issue: 257
source: review
date: 2026-03-31
---
When a component conditionally disables a button based on external state (useMergeProgress), the test must assert the disabled state directly — not just that the progress indicator text renders. A render-only assertion for the indicator would still pass if the disabled guard were removed. The test setup also needs to ensure all preconditions for button visibility (path, canMerge, ffmpegConfigured).
