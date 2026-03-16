---
scope: [scope/frontend]
files: [src/shared/schemas/settings/registry.test.ts, src/shared/schemas/settings/create-mock-settings.test.ts]
issue: 367
source: spec-review
date: 2026-03-16
---
Adding a new settings category to `settingsRegistry` has blast radius across shared test files (registry.test.ts, create-mock-settings.test.ts) and settings page composition tests. The spec named the production files but not the test surfaces. The `/elaborate` skill already has a Fixture Blast Radius check, but it was only triggered for DB schema changes — adding a settings category is the same pattern and should also trigger the check.
