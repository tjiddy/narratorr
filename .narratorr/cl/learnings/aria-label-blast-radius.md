---
scope: [frontend]
files: [src/client/components/AddBookPopover.tsx]
issue: 514
date: 2026-04-12
---
Adding `aria-label` to a button changes its accessible name, which breaks any test using `getByRole('button', { name: /^oldText$/i })`. When a shared component like AddBookPopover is used across multiple pages, the blast radius extends to all consuming test files (SuggestionCard, DiscoverPage, SearchPage). Grep for the old accessible name pattern across all `*.test.ts*` files before committing.
