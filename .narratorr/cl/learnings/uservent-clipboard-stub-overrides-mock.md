---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.test.tsx]
issue: 11
date: 2026-03-19
---
`userEvent.setup()` calls `attachClipboardStubToView()` internally, which replaces `navigator.clipboard` with a custom stub via `Object.defineProperty`. Any `Object.defineProperty(navigator, 'clipboard', ...)` calls made BEFORE `userEvent.setup()` are silently overwritten. Always call `userEvent.setup()` first, then set `navigator.clipboard` to the desired mock — or the mock will have no effect.
