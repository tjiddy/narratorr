---
scope: [scope/core]
files: [src/core/utils/naming.test.ts]
issue: 212
source: review
date: 2026-03-30
---
Reviewer caught that the new separator normalization behavior (comma-space collapse, consecutive separator collapse) was only tested through renderTemplate, not renderFilename. Both functions now share resolveTokens internally, but the public contract of renderFilename was untested for these edge cases. Prevention: when a shared internal helper changes behavior for multiple public functions, add direct tests for each public function — shared implementation doesn't mean shared test coverage.
