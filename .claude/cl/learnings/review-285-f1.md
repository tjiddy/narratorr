---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettings.tsx]
issue: 285
source: review
date: 2026-03-11
---
Generic settings form rendering only `requiredFields` as text inputs leaves provider-specific UI gaps (library selectors, list pickers, test/preview buttons). When implementing CRUD for a multi-provider system, create provider-specific settings components from the start rather than assuming all fields are simple text inputs. The registry metadata for required fields is for validation, not for rendering — rendering needs to understand field types and available options.
