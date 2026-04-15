---
scope: [frontend]
files: [src/shared/schemas/settings/system.ts, src/client/pages/settings/BackupScheduleForm.tsx]
issue: 564
date: 2026-04-15
---
When a settings category has fields managed by different UI surfaces (e.g., `dismissedUpdateVersion` managed by update-check UI vs `backupIntervalMinutes`/`backupRetention` managed by the backup form), you must create a custom `formSchema` using `stripDefaults().pick()` — the registry's `getFormSchema()` fallback includes all fields, which would overwrite the other surface's state on save.
