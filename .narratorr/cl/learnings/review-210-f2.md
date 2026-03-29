---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx, src/client/components/settings/NamingTokenModal.tsx]
issue: 210
source: review
date: 2026-03-29
---
Frontend tests mocked `renderTemplate`/`renderFilename` with functions that ignored the `options` third argument. This meant the preview reactivity through `namingOptions` was untested — if the options parameter were accidentally dropped from any preview call, the test suite would still pass. Fix: updated mocks to be options-aware (prepend a `[sep:X]`/`[case:X]` tag when non-default options are passed), then added interaction tests that change the separator/case dropdown and assert the tag appears in the preview. Pattern: when testing pass-through of new parameters, the mock must be sensitive to those parameters.
