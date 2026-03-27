---
scope: [frontend]
files: [src/client/components/WelcomeModal.tsx]
issue: 159
date: 2026-03-27
---
When replacing a large `old_string` that spans imports + interface definitions + function definitions, any interface or type definition sandwiched in the middle is silently removed. Tests still pass (Vitest doesn't typecheck), only `pnpm typecheck` catches the deletion. Always scope replacements to the smallest unique string that targets the change — never span from import lines to function bodies in a single Edit call.
