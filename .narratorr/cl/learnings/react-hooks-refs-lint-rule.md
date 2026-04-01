---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.tsx]
issue: 267
date: 2026-04-01
---
The `react-hooks/refs` ESLint rule disallows both reading and writing `ref.current` during render. The `react-hooks/set-state-in-effect` rule disallows `setState` inside `useEffect`. For "hold a value until a condition is met" patterns, use React's render-time setState pattern: `if (condition && state !== value) { setState(value); }`. React handles this by re-rendering before commit without extra paint. This is the recommended approach per React docs for "adjusting state when a prop changes."
