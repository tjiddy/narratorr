---
scope: [frontend]
files: [src/client/pages/discover/DiscoverySettingsSection.tsx, src/client/pages/discover/DiscoverySettingsSection.test.tsx]
issue: 215
source: review
date: 2026-03-30
---
Reviewer caught missing page-level test for hidden-field exclusion. Schema-level tests proved the schema omits weightMultipliers, but no page test verified that the component's pickFormFields() helper and form submission actually exclude it. When adding a new data-filtering behavior (hidden field exclusion, field mapping), test at the integration boundary (component submit → API call payload), not just the schema layer.
