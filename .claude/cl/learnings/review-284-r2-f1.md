---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/book/BookHero.tsx, src/client/pages/author/BookRow.tsx, src/client/pages/library/LibraryBookCard.tsx, src/client/components/book/BookMetadataModal.tsx, src/client/components/manual-import/BookEditModal.tsx]
issue: 284
source: review
date: 2026-03-10
---
Reviewer caught that inline `resolveUrl()` calls in 5 cover-rendering components had no `src` attribute assertions in tests. Test data used absolute URLs (`https://...`) which `resolveUrl` passes through unchanged, meaning deleting the `resolveUrl()` wrapper would leave tests green.

**Root cause:** When adding `resolveUrl` integration tests, only the `CoverImage` component (which has a dedicated wrapper) got a test. The 5 components that call `resolveUrl` inline on their own `<img>` elements were overlooked.

**Prevention:** When a utility function is used in N render sites, every render site needs its own test proving the utility is actually wired in. A single component-level test doesn't cover inline call sites in other components. Use app-relative URLs (not absolute) in these tests so the assertion would fail if `resolveUrl` were removed. Additionally, when a component has *multiple* inline calls (e.g., BookHero has foreground + background blur, BookEditModal has preview + alternatives), each call site needs its own assertion — one test per component isn't enough if the component has multiple call sites.
