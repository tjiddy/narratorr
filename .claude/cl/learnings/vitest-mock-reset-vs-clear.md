---
scope: [frontend]
files: [src/client/pages/settings/AppearanceSettingsSection.test.tsx, src/client/__tests__/setup.ts]
issue: 108
date: 2026-03-25
---
`vi.fn().mockClear()` only resets call counts — it does NOT reset the mock implementation. When a test overrides an implementation with `mockImplementation(...)`, subsequent tests in the same file see the modified implementation unless `mockReset()` + `mockImplementation(default)` is called in `beforeEach`. This caused one test failure where the "light preference" test saw the dark override from the preceding "dark preference" test. Fix: in `beforeEach`, call `mockReset()` and re-apply the default implementation explicitly.
