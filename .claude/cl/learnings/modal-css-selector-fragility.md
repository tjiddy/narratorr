---
scope: [frontend]
files: [src/client/pages/library/LibraryPage.test.tsx, src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 161
date: 2026-03-28
---
Modal component extraction changes CSS class ordering on the panel element, which breaks tests using `closest('div[class*="relative w-full"]')` selectors — the class `relative` and `w-full` are no longer adjacent after the refactor adds `glass-card` between them. Fix: use `getByRole('dialog')` or `getByTestId('modal-backdrop')` instead of CSS substring class selectors. Class ordering is an implementation detail that changes with any structural refactor.
