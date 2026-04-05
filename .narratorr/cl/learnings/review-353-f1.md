---
scope: [frontend]
files: [src/client/components/ToolbarDropdown.tsx, src/client/hooks/useEscapeKey.ts]
issue: 353
source: review
date: 2026-04-05
---
When two components register keydown handlers on `document`, registration order determines execution order in the same phase. The dropdown's handler must use **capture phase** (`addEventListener('keydown', handler, true)`) to guarantee it fires before the modal's bubble-phase `useEscapeKey` handler, regardless of which component mounts first. The implementation initially used bubble phase for both, which meant the modal handler fired first and closed the modal before the dropdown could suppress it.