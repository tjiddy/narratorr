---
scope: [frontend]
files: [src/client/components/ConfirmModal.tsx, src/client/pages/settings/ImportListsSettings.tsx]
issue: 285
date: 2026-03-11
---
ConfirmModal requires an `isOpen` prop — it returns null when false. Conditional rendering with `{x && <ConfirmModal .../>}` without passing `isOpen` silently breaks because `isOpen` defaults to undefined (falsy). Always render ConfirmModal unconditionally with `isOpen={target !== null}` instead of wrapping in conditional. The self-review subagent caught this one.
