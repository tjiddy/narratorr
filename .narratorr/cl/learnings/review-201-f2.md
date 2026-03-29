---
scope: [frontend]
files: [src/client/pages/library-import/LibraryImportPage.test.tsx]
issue: 201
source: review
date: 2026-03-29
---
When a test claims to prove a formula is independent of some variable (e.g., "reviewCount ignores selection"), it must exercise the variable — change the selection state and assert the count persists. A single assertion at the default state is not proof of independence; it would pass even if the implementation were wrong. Root cause: the "regardless of selection" qualifier in the AC was not translated into a selection-change assertion.
