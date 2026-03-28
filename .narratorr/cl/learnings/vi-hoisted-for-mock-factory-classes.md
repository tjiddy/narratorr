---
scope: [frontend]
files: [src/client/components/SearchReleasesModal.test.tsx]
issue: 63
date: 2026-03-24
---
When a `vi.mock()` factory needs to reference a class defined in the test file, the class must be defined with `vi.hoisted()` — `vi.mock` factories are hoisted before all imports and variable declarations, so any top-level class defined outside `vi.hoisted()` is inaccessible. Pattern: `const { MyClass } = vi.hoisted(() => { class MyClass extends Error { ... } return { MyClass }; });` — then use `MyClass` in both the factory and tests.
