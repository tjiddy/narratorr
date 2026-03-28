---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/components/book/BookMetadataModal.tsx, src/client/components/manual-import/BookEditModal.tsx]
issue: 161
source: review
date: 2026-03-28
---
The type="button" audit during implementation was incomplete — only added to buttons that were explicitly called out in AC text, not to all buttons in the migrated files. The AC said "preserve explicit button types during extraction" but the implementation only added type="button" to close/refresh/back buttons that were directly in scope. Inner component buttons (Grab, Blacklist, UnsupportedSection toggle, result-selection buttons, Cancel/Save) were missed. Fix: when the AC mentions type="button", do a full grep for <button tags in all changed files and add type="button" to every instance without it.
