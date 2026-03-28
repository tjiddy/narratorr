---
scope: [frontend]
files: [src/client/components/layout/Layout.tsx, src/client/components/layout/Layout.test.tsx]
issue: 99
date: 2026-03-25
---
Layout viewport-fill bugs are invisible in most unit tests because jsdom has no layout engine. The only reliable safety net is asserting the structural CSS classes (flex, flex-col, flex-1) directly on the DOM nodes. Per the learning from #106, layout contracts must be protected by structural regression tests — asserting CSS class presence is the correct approach for flex container / grow contracts even though "don't assert CSS classes" is the general rule.
