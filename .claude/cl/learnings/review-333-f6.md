---
scope: [frontend]
files: [src/client/components/layout/Layout.test.tsx, src/client/components/layout/Layout.tsx]
issue: 333
source: review
date: 2026-03-10
---
Reviewer caught that Layout.test.tsx never proved `<UpdateBanner />` was rendered in the shell. Standalone component tests existed but deleting the import in Layout.tsx wouldn't fail any test. Lesson: when wiring a new component into a parent, add at least one integration test in the parent's test file that proves the component appears — standalone component tests don't protect the wiring.
