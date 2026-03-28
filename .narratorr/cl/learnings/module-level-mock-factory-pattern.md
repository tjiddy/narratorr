---
scope: [frontend]
files: [src/client/pages/manual-import/ManualImportPage.test.tsx]
issue: 142
date: 2026-03-26
---
Module-level `let` variables for mocking hooks (e.g., `let mockMatchResults: MatchResult[] = []`) are fragile because maintainers can add new state and forget to reset it in `beforeEach`. The safer pattern: define a `makeMatchState()` factory function that returns a fresh object with all mock state fields, declare `let matchState = makeMatchState()` once at module level, and call `matchState = makeMatchState()` in `beforeEach`. The vi.mock factory closure reads from `matchState` at render time, and tests mutate `matchState.field = value` for per-test customization.
