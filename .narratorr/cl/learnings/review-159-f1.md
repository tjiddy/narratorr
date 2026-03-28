---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx]
issue: 159
source: review
date: 2026-03-27
---
The warning badge was left using semantic design tokens (`bg-destructive text-destructive-foreground`) instead of the explicit concrete color values (`bg-red-500 text-white`) required by the spec. The issue AC said "badge must use `bg-red-500 text-white rounded-full`" as a concrete pass/fail check, but during implementation the existing badge markup was left in place rather than updated. Prevented by: reading the spec's visual ACs literally during design polish and diffing the existing classes against the spec requirements.
