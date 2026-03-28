---
scope: [scope/frontend, scope/ui]
files: [src/client/components/Button.tsx, src/client/components/Button.test.tsx]
issue: 162
source: review
date: 2026-03-28
---
When a component uses ...rest spread to forward arbitrary HTML attributes, tests must explicitly verify a non-trivial attribute (e.g., form, aria-label) reaches the DOM element. Class/type/onClick tests alone do not prove the spread works. Add at least one test with a non-standard HTML attribute that would only be present via the spread.
