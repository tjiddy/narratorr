---
name: new-component-blast-radius-check
description: When a new component uses API on mount, all parent test files that render the parent must mock that component or add the API method to their mock
type: feedback
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.test.tsx, src/client/pages/settings/GeneralSettings.test.tsx, src/client/pages/SettingsPage.test.tsx]
issue: 135
date: 2026-03-26
---

When a new component calls an API method on mount (e.g., `api.getActiveBulkJob()` in `useBulkOperation`), ALL ancestor component tests that render the component will fail with `api.getActiveBulkJob is not a function` if their mock doesn't include that method.

**Fix:** Add a null-render mock for the new component in every ancestor test file:
```ts
vi.mock('@/components/library/BulkOperationsSection', () => ({
  BulkOperationsSection: () => null,
}));
```

**Alternatively:** Add the new API method to the shared mock api object in test helpers.

**Why:** Testing Library renders the real component tree. If `LibrarySettingsSection` renders `BulkOperationsSection`, and `BulkOperationsSection` calls `api.getActiveBulkJob()` on mount, and the test's `vi.mock('@/lib/api', ...)` doesn't include `getActiveBulkJob`, the test fails immediately on mount.

**How to apply:** After adding a new component with API calls, run the full test suite and check for `is not a function` errors in parent component tests. Fix by adding the mock in those files (or adding the API method to `createMockApi` in test helpers).
