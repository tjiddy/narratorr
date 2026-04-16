---
scope: [frontend]
files: [src/client/pages/settings/ImportListsSettings.tsx, src/client/pages/settings/CrudSettingsPage.tsx, src/client/components/settings/ImportListCard.tsx]
issue: 607
date: 2026-04-16
---
When migrating a custom CRUD page to CrudSettingsPage with modal, the biggest gotchas are behavioral differences: (1) header Add button stays enabled in modal mode (`disabled={!modal && showForm}`), (2) Cancel button routes through `handleModalClose` which blocks during pending mutations. Both are intentional shared-modal behavior but break existing tests that assert the old inline behavior. Also, CrudSettingsPage's test infrastructure (`onFormTest` for create, `onTest(id)` for edit) replaces local test state — the card component should delegate to these handlers rather than managing its own test API calls.
