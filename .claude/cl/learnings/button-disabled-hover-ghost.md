---
scope: [frontend]
files: [src/client/components/Button.tsx, src/client/components/TestButton.tsx]
issue: 162
date: 2026-03-28
---
When a shared Button component uses disabled:opacity-50 for disabled state, the hover:bg-muted on secondary variant still visually fires on hover. Adding disabled:hover:bg-transparent prevents this ghost-hover effect. TestButton passes this as className; in future, consider adding it to the secondary variant class string in Button itself so all consumers get it automatically.
