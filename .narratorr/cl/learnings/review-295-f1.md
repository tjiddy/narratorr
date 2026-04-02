---
scope: [frontend]
files: [src/client/pages/settings/ImportSettingsSection.tsx]
issue: 295
source: review
date: 2026-04-02
---
When hiding validation errors on disabled fields (`{errors.field && condition && ...}`), consider the case where an invalid value was entered before the field was disabled. The Zod resolver still validates the field regardless of disabled state, so hiding the error creates a silent save failure — the user sees no error but the form refuses to submit. Fix: always show validation errors even on disabled fields, so the user knows what's blocking save. The same pattern exists in ProcessingSettingsSection:286 (`errors.bitrate && !keepOriginalBitrate`) as pre-existing debt.
