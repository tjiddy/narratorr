---
scope: [infra, testing]
files: [e2e/tests/smoke/library.spec.ts]
issue: 612
date: 2026-04-16
---
Playwright's `page.getByText('...')` matches substrings by default AND runs in strict mode, so any second DOM node containing the target substring causes a "strict mode violation" failure — even when the real target is a different element. The library-page smoke hit this because "Your audiobook collection" appears as a subtitle AND as a substring in an empty-state message ("Start building your audiobook collection..."). Pass `{ exact: true }` whenever the target text is a distinct literal and not a prefix. For assertions where shape matters more than text (e.g. headings), prefer `getByRole('heading', { name: '...' })` — role-based locators dodge substring collisions entirely.
