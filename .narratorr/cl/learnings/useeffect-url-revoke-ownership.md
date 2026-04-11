---
scope: [frontend]
files: [src/client/pages/book/BookDetails.tsx]
issue: 466
date: 2026-04-11
---
React's `useEffect` cleanup with a state dependency (`[coverPreviewUrl]`) fires on every state change, not just unmount. This means a single `useEffect` cleanup can own the entire blob URL lifecycle — manual `URL.revokeObjectURL` calls in event handlers are redundant when the handler also sets the state that triggers the effect cleanup. The effect-only model eliminates double-revoke risk and simplifies callback dependencies (no need to close over the current URL).
