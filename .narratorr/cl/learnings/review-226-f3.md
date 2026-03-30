---
scope: [frontend, core]
files: [src/core/utils/naming.ts, src/shared/schemas/settings/library.ts, src/client/pages/settings/NamingSettingsSection.tsx]
issue: 226
source: review
date: 2026-03-30
---
When adding a regex that matches the same grammar as an existing regex in the codebase, DRY-2 applies even for small patterns. The token grammar `/\{(\w+)(?::(\d+))?(?:\?([^}]*))?\}/` existed in naming.ts and library.ts; adding a third copy in the component was flagged as drift risk. Export a `TOKEN_PATTERN_SOURCE` string constant and construct site-specific RegExp variants (with/without `g` flag, with/without `^$` anchors) from it. Also: updating mocks in test files that mock the barrel module is required when exporting a new constant — check all `vi.mock('@core/utils/index.js')` sites.
