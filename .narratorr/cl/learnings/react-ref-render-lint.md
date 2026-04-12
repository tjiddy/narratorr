---
scope: [frontend]
files: [src/client/hooks/useSettingsForm.ts]
issue: 485
date: 2026-04-12
---
React hooks lint rule `react-hooks/refs` flags `ref.current = value` during render as an error. The standard "update ref in render" pattern must use `useEffect` (no deps) instead of direct assignment. This also applies to passing ref objects to function calls during render — wrap in arrow functions so the ref is only accessed at event time.
