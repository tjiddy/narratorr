---
scope: [frontend]
files: [src/client/components/Modal.tsx, src/client/hooks/useFocusTrap.ts, src/client/hooks/useEscapeKey.ts]
issue: 551
date: 2026-04-14
---
When adding useFocusTrap to a base component like Modal, React effect order matters: child (Modal) effects fire before parent (consumer) effects. Consumer hooks like useEscapeKey autofocus their ref on mount, so initial focus lands on the consumer's inner dialog wrapper even though the base Modal's trap focused the panel first. This is desirable — the trap catches Tab while consumers control initial focus. The WelcomeModal isPending effect is a separate path that overrides focus independently.
