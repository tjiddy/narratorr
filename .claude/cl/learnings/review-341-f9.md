---
scope: [scope/frontend]
files: [src/client/pages/settings/NetworkSettingsSection.test.tsx]
issue: 341
source: review
date: 2026-03-12
---
Reviewer caught missing test for the proxy URL sentinel (`********`) round-trip. The network schema has special sentinel passthrough logic — when the server returns a masked value, the form must accept it without validation errors. This is a schema-level edge case that should be tested whenever zodResolver is wired to a schema with special-case validation logic.
