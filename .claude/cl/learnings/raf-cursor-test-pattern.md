---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx, src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 82
date: 2026-03-25
---
Testing `setSelectionRange` calls made inside `requestAnimationFrame` (jsdom implements rAF as `setTimeout(fn, 0)`) requires flushing the timer before asserting `input.selectionStart`. Using `vi.useFakeTimers()` BEFORE the component renders causes `waitFor()` to hang (it uses `setInterval` internally). The safe pattern: render and load the component with real timers, do interactions, then flush rAF with `await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); })` — this flushes the rAF callback without fake timers. Also: `screen.getByPlaceholderText()` returns `HTMLElement` but `selectionStart` is on `HTMLInputElement` — cast with `as HTMLInputElement` to avoid TS errors.
