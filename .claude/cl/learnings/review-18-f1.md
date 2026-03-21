---
scope: [frontend]
files: [src/client/pages/settings/LibrarySettingsSection.tsx]
issue: 18
source: review
date: 2026-03-21
---
After a partial (path-only) autosave, RHF isDirty stays true because the field's default value was never updated. The Save button continued to render even though the path was already saved. Fix: call `resetField('path', { defaultValue: savedPath })` in pathSaveMutation.onSuccess to update the RHF default for that field, clearing its dirty contribution while preserving sibling field dirty state. Missing from implementation because the spec said "sibling fields unaffected" but didn't explicitly state the path field itself should no longer be dirty after autosave.
