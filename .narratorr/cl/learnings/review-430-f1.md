---
scope: [frontend]
files: [src/client/pages/activity/MergeCard.tsx]
issue: 430
source: review
date: 2026-04-09
---
Frontend-design pass overrode the spec-approved hover token (hover:border-primary/20 → hover:border-primary/30 + hover:shadow-md) without updating the issue spec. Root cause: glass-card provides border-border/50 at rest, and MergeCard's explicit `border border-primary/20` made the hover a no-op. Fix: remove the explicit rest border (let glass-card handle it) and use the spec-approved hover token. Prevention: when frontend-design diverges from the spec, update the spec AC or flag the divergence in the PR body.
