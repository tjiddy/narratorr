---
scope: [frontend]
files: [src/client/hooks/useSettingsForm.ts, src/client/pages/settings/SystemSettings.test.tsx]
issue: 485
date: 2026-04-12
---
When extracting a shared settings hook with a `select` function, tests that mock `api.getSettings` with partial settings objects (e.g., only `{ system: {...} }`) will crash if `select` accesses categories that aren't in the mock. The original per-section code guarded with `settings?.category`, but the shared hook's generic `select(settings)` call doesn't have category-level guards. Solution: wrap the `select` call in try/catch inside the useEffect, falling back silently when settings is incomplete.
