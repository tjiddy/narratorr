---
scope: [frontend]
files: [src/client/components/settings/formStyles.ts, src/client/components/settings/BlackholeFields.test.tsx]
issue: 289
source: review
date: 2026-04-01
---
When extracting shared style constants/helpers from multiple components, the test plan must cover BOTH branches of any conditional (error AND non-error). The handoff coverage review verified the error branch was tested indirectly but missed that the default/non-error branch had no consumer assertion proving `border-border` was applied. For shared helpers with conditional behavior, add at least one representative consumer test per branch — even when the extraction is "just moving constants."
