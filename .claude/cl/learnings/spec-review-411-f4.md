---
scope: [scope/backend, scope/services]
files: []
issue: 411
source: spec-review
date: 2026-03-16
---
Reviewer caught that adding `patch()` as a public SettingsService method would require updating `createMockSettingsService()` in the test helpers. Root cause: spec didn't consider blast radius on test infrastructure. Prevention: when a spec adds a public method to a service, check the test helpers file for mock factories that enumerate the service's public API — note them in a Blast Radius section.
