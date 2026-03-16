---
scope: [scope/frontend]
files: [src/client/pages/settings/GeneralSettings.test.tsx]
issue: 341
source: review
date: 2026-03-12
---
Cross-section dirty-state test asserted form values after query invalidation but never actually triggered a save/refetch cycle. The test just dirtied two sections and checked values — it didn't exercise the path where saving one section triggers a refetch that could clobber the other's dirty state. Gap: test plan didn't specify the exact interaction chain (save → refetch → isDirty guard).
