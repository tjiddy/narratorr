---
scope: [scope/frontend]
files: [src/client/pages/settings/SystemSettings.tsx]
issue: 280
source: review
date: 2026-03-10
---
The confirm restore mutation was untested — no test clicked "Restore Now" in the modal or asserted the POST and subsequent behavior. Prevention: confirmation modals that trigger destructive actions must have end-to-end interaction tests covering the full click-through.
