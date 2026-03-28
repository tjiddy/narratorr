---
scope: [frontend]
files: [src/client/components/DirectoryBrowserModal.tsx]
issue: 50
date: 2026-03-21
---
Buttons without explicit `type="button"` default to `type="submit"` inside any HTML `<form>` ancestor — even when the modal is rendered via a portal or deeply nested. When `DirectoryBrowserModal` was used inside `LibrarySettingsSection`'s `<form>`, clicking Cancel or Select triggered form submission instead of the intended action. Every `<button>` in a shared component must have `type="button"` unless it is explicitly a submit button. This is documented in CLAUDE.md but is easy to forget in components created before they're used in form contexts.
