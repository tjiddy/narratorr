---
scope: [frontend]
files: [src/client/index.css, src/client/pages/book/BookDetails.tsx]
issue: 430
date: 2026-04-09
---
Applying both `animate-fade-in-up` and `animate-fade-out` on the same element works because CSS animations with `forwards` fill mode lock to their end state, and `animation-delay` on the fade-out (2s) ensures it starts well after fade-in-up (0.5s) completes. The key constraint is that `DISMISS_DELAY_MS` (3000ms) must equal delay + duration (2000 + 1000) so the store cleanup fires as the animation completes — otherwise the element vanishes mid-fade or lingers invisibly.
