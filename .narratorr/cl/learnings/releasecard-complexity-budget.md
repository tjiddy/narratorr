---
scope: [frontend]
files: [src/client/components/ReleaseCard.tsx]
issue: 421
date: 2026-04-08
---
ReleaseCard has an eslint complexity suppression (line 14, limit 15). Adding conditional badges is low-cost (one boolean + one JSX conditional), but each new badge inches closer to needing extraction. If a future issue adds another conditional badge, consider extracting the badge row into a `ReleaseCardBadges` sub-component.
