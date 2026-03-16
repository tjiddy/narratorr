---
scope: [frontend]
files: [src/client/pages/settings/ImportSettingsSection.test.tsx]
issue: 358
source: review
date: 2026-03-14
---
Same root cause as F1 — merge conflict resolution dropped validation tests for `minSeedTime < 0` rejection. When a test file has merge conflicts unrelated to the PR's scope, after resolution, compare the test count and coverage categories against what existed before to catch silent coverage regression.
