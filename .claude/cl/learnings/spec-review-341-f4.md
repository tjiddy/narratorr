---
scope: [scope/frontend]
files: []
issue: 341
source: spec-review
date: 2026-03-11
---
Spec had contradictory cache-invalidation behavior: "all sections reset to fresh server state" vs "unsaved changes are preserved." This is a common pattern when spec bullets are written independently without cross-checking. Fix: `/elaborate` should scan System Behaviors for state transition claims and flag any pair where the same event (cache invalidation) has conflicting outcomes for the same entity (section form state).
