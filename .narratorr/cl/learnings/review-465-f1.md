---
scope: [frontend]
files: [src/client/pages/activity/MergeCard.test.tsx]
issue: 465
source: review
date: 2026-04-11
---
When extracting a child component from a parent, the parent's existing tests may cover text/behavior but not the visual wiring (icon classes, SVG rendering). The reviewer caught that MergeCard.test.tsx had no icon assertions despite the component now delegating icon rendering through a new prop contract. Lesson: after extraction, verify that each consumer's test file asserts the extracted behavior at the consumer level, not just at the shared component level.