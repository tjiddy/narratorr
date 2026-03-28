---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/settings/GeneralSettings.test.tsx]
issue: 157
source: review
date: 2026-03-27
---
The escape hatch had tests for mutation payload and toast, but no test proved queryKeys.settings() invalidation actually happens.

Why: Tests focused on what the mutation sends but not on the downstream cache-bust consequence.

What would have prevented it: For mutations that must invalidate a query cache, add a test checking api.getSettings is called >=2 times after success. Pattern: expect(mockApi.getSettings.mock.calls.length).toBeGreaterThanOrEqual(2).
