---
scope: [frontend]
files: [src/client/pages/settings/SecuritySettings.tsx]
issue: 11
date: 2026-03-19
---
`document.execCommand('copy')` returns `false` on failure without throwing. A try/catch alone is insufficient — you must check the boolean return value and explicitly throw to reach the catch block. Also, jsdom does not define `document.execCommand` at all; mock it via `Object.defineProperty(document, 'execCommand', { value: vi.fn(), configurable: true, writable: true })` rather than `vi.spyOn(document, 'execCommand')`, which fails when the property doesn't exist.
