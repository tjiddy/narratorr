---
scope: [frontend, backend]
files: [src/client/components/layout/Layout.test.tsx, src/shared/schemas/settings/create-mock-settings.ts]
issue: 157
date: 2026-03-27
---
Adding a new settings field with a "falsy default" (e.g., `welcomeSeen: false`) requires updating Layout.test.tsx's `beforeEach` to mock settings with `welcomeSeen: true`, because `createMockSettings()` deep-merges from `DEFAULT_SETTINGS` which now includes the new field. Without this, every existing Layout test would unexpectedly see the modal rendered. The pattern: whenever a new "display condition" field is added to settings, the Layout test `beforeEach` must explicitly opt out of that condition by setting the field to its non-triggering value.
