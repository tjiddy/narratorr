---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 18
date: 2026-03-21
---
RHF's `register()` returns `onBlur: ChangeHandler` where `ChangeHandler = (event: { target: any; type?: any }) => Promise<void | boolean>`. To compose a custom blur handler without modifying PathInput, destructure `onBlur` from `register('path')`, declare the custom handler as `typeof rhfPathOnBlur` (async), and use `e.target as HTMLInputElement` for the value. This satisfies ChangeHandler's type while allowing custom logic after calling `rhfPathOnBlur(e)`. Using `e.currentTarget` instead would trigger a contravariant parameter type mismatch.
