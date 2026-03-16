---
scope: [frontend]
files: [apps/narratorr/src/client/pages/settings/SecuritySettings.test.tsx]
issue: 256
source: review
date: 2026-03-05
---
Query invalidation is a critical side effect of mutations — if invalidateQueries is removed, stale auth state persists. Tests that only check toasts and field resets miss this. Pattern: clear mock call counts after initial render, then verify query functions are re-called after the mutation succeeds.
