---
scope: [scope/frontend]
files: [src/client/pages/settings/SearchSettingsSection.test.tsx, src/client/pages/settings/ImportSettingsSection.test.tsx, src/client/pages/settings/QualitySettingsSection.test.tsx]
issue: 339
source: spec-review
date: 2026-03-11
---
Pattern A file inventory was incomplete — missed 3 settings test files that have the same `toHaveValue` assertions after `user.clear()`/`user.type()` on number inputs. The spec listed these files under Pattern B (number input fix) but not Pattern A (waitFor wrapping), even though the `toHaveValue` assertions are the same flaky surface. When building an inventory of affected files, cross-reference all patterns against all files — a file can need fixes from multiple patterns simultaneously.
