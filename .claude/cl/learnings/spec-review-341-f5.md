---
scope: [scope/frontend]
files: [src/client/pages/settings/GeneralSettings.test.tsx]
issue: 341
source: spec-review
date: 2026-03-11
---
Spec didn't enumerate the blast radius of affected test files for a form-architecture refactor. The elaborate step identified the settings blast radius pattern from workflow history but didn't list specific test files in the spec. Fix: for refactoring issues, `/elaborate` should glob for `*.test.ts*` in the target directory and list files whose test setup depends on the architecture being changed.
