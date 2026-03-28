---
scope: [frontend]
files: [src/client/components/manual-import/ImportCard.tsx, src/client/components/manual-import/ImportCard.test.tsx]
issue: 163
source: review
date: 2026-03-27
---
When migrating inline badge patterns to a shared component, existing tests that only assert label text (toHaveTextContent) do not verify the variant wiring. Adding a Badge abstraction creates a new failure mode: the wrong variant could be passed silently. At call sites that use a shared component with a variant prop, add a companion test that asserts the specific variant class on the badge element (toHaveClass), not just the visible text. This catches variant mapping bugs before they reach review.
