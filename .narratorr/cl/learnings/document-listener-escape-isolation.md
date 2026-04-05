---
scope: [frontend]
files: [src/client/hooks/useEscapeKey.ts, src/client/components/ToolbarDropdown.tsx]
issue: 353
date: 2026-04-05
---
When two components both register `keydown` handlers on `document`, `stopPropagation()` does NOT prevent the other handler from firing — they're on the same target. Use `stopImmediatePropagation()` to suppress same-target listeners, and/or check `e.defaultPrevented` in the handler you want to gate. This two-sided approach (producer calls `stopImmediatePropagation` + `preventDefault`, consumer checks `defaultPrevented`) is robust against listener registration order.