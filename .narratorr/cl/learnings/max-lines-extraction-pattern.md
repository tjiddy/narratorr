---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.tsx]
issue: 226
date: 2026-03-30
---
ESLint `max-lines-per-function` (150 lines) in NamingSettingsSection is tight. Adding a ~20-line handler inside the component pushed it to 160 lines. Extract keyboard/event handlers as module-level factory functions (e.g., `createFormatKeyDownHandler`) that take `setValue` as a parameter — keeps the component body lean and the handler testable in isolation.
