---
scope: [frontend]
files: [src/client/pages/activity/ImportBatchBanner.tsx, src/client/pages/activity/ActiveTabSection.tsx]
issue: 637
date: 2026-04-18
---
The `react-hooks/purity` lint rule flags `Date.now()` in render bodies — even inside `useMemo`. For components that need "current time" (e.g., cooldown calculations), pass `now` as a prop from the parent, or use `useState(() => Date.now())` with a `setInterval` to refresh periodically. This keeps the render function pure and testable (tests inject a fixed timestamp).
