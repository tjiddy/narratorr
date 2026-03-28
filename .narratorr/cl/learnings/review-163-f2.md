---
scope: [frontend]
files: [src/client/components/manual-import/BookEditModal.tsx, src/client/components/manual-import/BookEditModal.test.tsx]
issue: 163
source: review
date: 2026-03-27
---
When a shared component adds a className passthrough prop that is used at a call site for layout purposes (shrink-0), a test must assert the class is applied to the rendered element. A text-presence test ('In library' visible) does not catch the className regression. For every call site that passes className to Badge (or any shared component), add an assertion that the forwarded class appears on the element's classList.
