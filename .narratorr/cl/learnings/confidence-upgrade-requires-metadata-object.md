---
scope: [frontend, infra]
files: [src/client/pages/manual-import/useManualImport.ts, src/client/components/manual-import/BookEditModal.tsx]
issue: 616
date: 2026-04-17
---
The confidence upgrade from 'none' to 'medium' in `useManualImport.handleEdit` requires `state.metadata` to be truthy (line 155-163). Simply filling in title/author text fields in the BookEditModal and saving is NOT sufficient — `selectedMetadata` must be non-null, which requires the user to click a search result in the modal. This means any E2E test exercising the Edit Metadata → Import flow needs the metadata search (Audible API) to return at least one result for the in-modal keyword search.
