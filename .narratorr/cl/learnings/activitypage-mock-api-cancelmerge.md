---
scope: [frontend]
files: [src/client/pages/activity/ActivityPage.test.tsx]
issue: 478
date: 2026-04-11
---
The ActivityPage test mock API object (`vi.mock('@/lib/api', ...)`) must explicitly include every `api.*` method used by the component. `cancelMergeBook` was missing from the mock, which would have caused "not a function" errors. When adding tests for new mutation paths in ActivityPage, always check the mock spread first.
