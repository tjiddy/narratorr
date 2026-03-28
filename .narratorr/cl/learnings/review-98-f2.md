---
scope: [scope/frontend]
files: [src/client/pages/manual-import/PathStep.tsx]
issue: 98
source: review
date: 2026-03-25
---
When adding a hover state to an "active/on" icon button that already sits at full emphasis (e.g., favorited heart at `text-primary`), adding `hover:text-primary/80` creates a dimming effect on hover. This makes the "on" state appear LESS emphasized on hover than the "off" state button (which goes from muted to full amber on hover), inverting the intended visual hierarchy.

**Why missed:** The change was mechanical — "solid amber rest state, add a hover variant" — without checking whether the hover variant of the favorited state would be visually stronger or weaker than the hover variant of the unfavorited state. Two buttons side-by-side on hover need a hierarchy check, not just an individual check.

**What would have prevented it:** When two interactive controls exist in a visual pair with opposite states (favorited/unfavorited, on/off), compare their hover colors directly: at every interaction state, is the "on" variant still more visually emphasized than the "off" variant? `hover:text-primary/80` vs `hover:text-primary` — the `/80` reduces emphasis and breaks the hierarchy.
