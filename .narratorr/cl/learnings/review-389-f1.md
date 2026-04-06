---
scope: [frontend]
files: [src/client/pages/settings/SearchSettingsSection.test.tsx]
issue: 389
source: review
date: 2026-04-06
---
When moving a field between cards (protocolPreference from Quality to Search), tests must exercise the field with a non-default server value AND a user-driven change. Seeding only the default value and never interacting with the control leaves the toFormData/toPayload wiring untested. Always test moved controls with non-default load + change + save.
