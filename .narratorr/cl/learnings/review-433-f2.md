---
scope: [scope/frontend]
files: [src/client/pages/settings/CrudSettingsPage.tsx]
issue: 433
source: review
date: 2026-03-17
---
Reviewer caught that the new `headerExtra` prop/rendering branch in CrudSettingsPage had zero test coverage. Since DownloadClientsSettings (the first consumer) doesn't pass headerExtra, deleting the rendering code would fail no tests. Missed because tests focused on the existing DownloadClientsSettings integration tests rather than also testing the new component's own interface surface. Prevention: when extracting a generic component with optional props, add at least one component-level test per optional rendering branch — even if no current consumer exercises it.
