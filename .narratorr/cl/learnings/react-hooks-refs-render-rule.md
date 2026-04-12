---
scope: [frontend]
files: [src/client/hooks/useSettingsForm.ts]
issue: 514
date: 2026-04-12
---
React's `react-hooks/refs` lint rule forbids `ref.current = value` during render. To sync a reactive value (like `formState.isDirty`) into a ref for use in a separate effect, assign via a dedicated `useEffect(() => { ref.current = value }, [value])` instead of directly in the component body.
