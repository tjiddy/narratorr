---
scope: [frontend]
files: [src/client/components/manual-import/BookEditModal.test.tsx]
issue: 185
source: review
date: 2026-03-28
---
When testing icon swap behavior (e.g., SearchIcon → LoadingSpinner during pending), asserting only the button's disabled state is insufficient — the button would still be disabled even without the spinner. Must assert the icon's presence via `data-testid` (e.g., `screen.getByTestId('loading-spinner')`) to prove the visual swap actually occurs.
