---
scope: [frontend]
files: [src/client/components/AudioInfo.tsx, src/client/pages/book/helpers.ts, src/client/pages/search/SearchBookCard.tsx]
issue: 487
source: review
date: 2026-04-11
---
When refactoring import sources (moving a function from one module to another), every updated call site needs a regression test that asserts the formatted output — not just that the component renders. Existing component tests may cover other aspects (channels, quality tier) but miss the specific formatter wiring. The plan should enumerate which call sites already have format-specific assertions and which need new ones.
