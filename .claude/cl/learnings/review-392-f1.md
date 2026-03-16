---
scope: [backend]
files: [src/shared/schemas/settings/create-mock-settings.ts]
issue: 392
source: review
date: 2026-03-15
---
Reviewer caught that `{ ...DEFAULT_SETTINGS }` only shallow-clones the top level — nested category objects are shared references. Mutating `createMockSettings().processing.enabled` would also mutate `DEFAULT_SETTINGS.processing.enabled` and break subsequent factory calls in other tests. The fix was to use `JSON.parse(JSON.stringify(...))` for full isolation. The "does not mutate DEFAULT_SETTINGS" test existed but only tested the override path — the no-override path was untested.
