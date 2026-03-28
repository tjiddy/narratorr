---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.tsx, src/client/components/SearchReleasesModal.test.tsx]
issue: 187
date: 2026-03-28
---
React prevents click events on `disabled` buttons at the browser level — neither `userEvent.click` nor `fireEvent.click` fires the `onClick` handler on a disabled element. Defensive guards inside handlers that are always unreachable via UI (because the button is disabled when the guard condition is true) cannot be tested via Testing Library interaction. These guards are dead code from a test perspective; do not write tests for them.
