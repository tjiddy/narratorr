---
scope: [frontend]
files: [src/client/pages/settings/NamingSettingsSection.test.tsx]
issue: 217
date: 2026-03-30
---
`toHaveValue()` from jest-dom does exact comparison — cannot use `expect.stringContaining()` inside it. When asserting partial input value after programmatic insertion (like `insertTokenAtCursor`), cast to `HTMLInputElement` and use `.value` with `.toContain()` instead.
