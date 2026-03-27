---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx, src/client/hooks/useEscapeKey.ts]
issue: 159
date: 2026-03-27
---
`useEscapeKey(false, handler, ref)` short-circuits immediately and never attaches a listener — it's a complete no-op. If the intent is "no escape to dismiss", just remove the hook call entirely rather than passing `false`. Leaving it in misleads readers into thinking it's doing something useful.
