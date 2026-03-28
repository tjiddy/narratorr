---
scope: [frontend]
files: [src/client/components/ToolbarDropdown.tsx]
issue: 106
date: 2026-03-25
---
The `react-hooks/refs` ESLint rule prohibits accessing `ref.current` during render. Any dropdown/popover that computes portal position from `triggerRef.current.getBoundingClientRect()` must compute position inside a `useEffect` (with state), not inline in the JSX or render body. The fix: `const [position, setPosition] = useState<Position>({ top: 0, left: 0 })` + `useEffect` that calls `updatePosition()` when `open` changes. Without this, the lint gate blocks the verify step and reveals itself only at `scripts/verify.ts` time, not during local development.
