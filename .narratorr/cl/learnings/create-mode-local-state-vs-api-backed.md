---
scope: [frontend]
files: [src/client/components/settings/PathMappingEditor.tsx, src/client/components/settings/RemotePathMappingsSubsection.tsx]
issue: 263
date: 2026-04-01
---
When a create form needs child records that don't exist yet (no parent ID), create a separate local-state component rather than adding a mode prop to the existing API-backed component. `RemotePathMappingsSubsection` uses `useQuery`/`useMutation` requiring `clientId` — making it dual-mode would require conditional hook calls (illegal in React) or complex state management. A dedicated `PathMappingEditor` with `onChange` callback is simpler and the parent merges the state into the create payload via `handleFormSubmit`.
