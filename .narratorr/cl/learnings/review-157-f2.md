---
scope: [scope/frontend, scope/ui]
files: [src/client/components/WelcomeModal.tsx]
issue: 157
source: review
date: 2026-03-27
---
Used grid-cols-2 as the mobile base for the feature-highlights row, which forces a 2-column layout on small screens. The correct base is grid-cols-1 (single column mobile).

Why: The first two rows correctly used grid-cols-1 sm:grid-cols-3. The third row deviated to grid-cols-2.

What would have prevented it: Always start from grid-cols-1 (mobile-first) unless a multi-column layout at the smallest viewport is explicitly required.
