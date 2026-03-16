---
scope: [frontend]
files: [src/client/pages/settings/SystemSettings.test.tsx]
issue: 279
source: review
date: 2026-03-10
---
Child component tests pass in isolation even if the child is never mounted by its parent. Always add a page-level test asserting section headings/testids appear together when integrating new child components into existing pages. This catches parent wiring regressions that component-level tests miss.
