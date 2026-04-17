---
scope: [backend, services]
files: [src/client/components/settings/useFetchCategories.test.ts, src/server/routes/import-lists.test.ts, src/client/pages/settings/LibrarySettingsSection.test.tsx]
issue: 629
source: review
date: 2026-04-17
---
Mechanical refactoring (removing a parameter) still changes error-path behavior contracts at call sites. Even when the runtime behavior is identical, the reviewer expects every changed catch/onError branch to have a test that asserts the exact error message propagation — not just that "some error toast fired." When migrating call sites, scan existing tests for weak assertions (`.toHaveBeenCalled()` without arguments) on the changed error paths and tighten them preemptively.
