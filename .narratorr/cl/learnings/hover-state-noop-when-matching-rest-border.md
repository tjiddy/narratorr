---
scope: [frontend]
files: [src/client/pages/activity/MergeCard.tsx]
issue: 430
date: 2026-04-09
---
Adding `hover:border-primary/20` to an element that already has `border border-primary/20` at rest produces a no-op hover — there's no visual change. The spec said "match DownloadCard" but DownloadCard's `glass-card` provides a different default border, so the hover change is visible there. When an element already has an explicit border matching the hover target, bump the hover opacity higher (e.g., `/30`) or add `hover:shadow-md` for a visible effect.
