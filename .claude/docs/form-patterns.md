# Divergent Form Patterns

Most settings sections use the `useSettingsForm` hook for form state, validation, and API submission. The following 8 components do **not** use the hook, each for a specific reason.

## Non-API storage

| Component | File | Rationale |
|-----------|------|-----------|
| `AppearanceSettingsSection` | `src/client/pages/settings/AppearanceSettingsSection.tsx` | Theme is stored in localStorage via `useTheme`, not the settings API. |

## Non-settings authentication

| Component | File | Rationale |
|-----------|------|-----------|
| `CredentialsSection` | `src/client/pages/settings/CredentialsSection.tsx` | Authentication form with password validation, not a settings API patch. |

## Hybrid state management

| Component | File | Rationale |
|-----------|------|-----------|
| `LibrarySettingsSection` | `src/client/pages/settings/LibrarySettingsSection.tsx` | Uses `setQueryData` for optimistic cache update and `resetField` for single-field reset, which don't fit the hook's full-form reset model. |

## Entity CRUD lifecycle

These components manage create/edit/delete/test operations on individual entities, not single-category settings patches.

| Component | File | Rationale |
|-----------|------|-----------|
| `CrudSettingsPage` | `src/client/pages/settings/CrudSettingsPage.tsx` | Manages entity CRUD lifecycles (create/edit/delete/test). |
| `ImportListsSettings` | `src/client/pages/settings/ImportListsSettings.tsx` | Dynamic CRUD list managing import list entities. |
| `IndexerCard` | `src/client/components/settings/IndexerCard.tsx` | Entity form for indexer CRUD. |
| `NotifierCard` | `src/client/components/settings/NotifierCard.tsx` | Entity form for notifier CRUD. |
| `DownloadClientCard` | `src/client/components/settings/DownloadClientCard.tsx` | Entity form for download client CRUD. |
