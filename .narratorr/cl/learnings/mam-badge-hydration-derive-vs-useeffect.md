---
scope: [frontend]
files: [src/client/components/settings/IndexerFields.tsx]
issue: 339
date: 2026-04-04
---
For hydrating UI state from persisted form values (e.g., showing a VIP badge from saved `isVip` + `mamUsername`), pass the initial value to `useState()` rather than using `useEffect` to set it after mount. This avoids a flash of no-badge on edit form open. The `deriveInitialMamStatus()` helper computes the initial state from `watch()` values and feeds it to the hook constructor. Separately, the `formTestResult` bridge uses `useEffect` because it reacts to external prop changes — different pattern, different tool.
