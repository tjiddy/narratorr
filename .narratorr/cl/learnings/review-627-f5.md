---
scope: [frontend]
files: [src/client/components/book/MetadataResultList.test.tsx]
issue: 627
source: review
date: 2026-04-17
---
When fixing review findings by adding new props (itemClassName, dataTestId), always add tests for those props in the same commit. Props added without tests are invisible to the test suite and can regress silently. The rule: every new prop path needs at least one positive test proving it reaches the DOM.
