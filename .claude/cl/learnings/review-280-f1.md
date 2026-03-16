---
scope: [scope/frontend, scope/ui]
files: [src/client/pages/settings/SystemSettings.tsx, src/client/pages/settings/BackupScheduleForm.tsx]
issue: 280
source: review
date: 2026-03-10
---
The System Settings page was built with backup list/create/restore but omitted the editable controls for backupIntervalMinutes and backupRetention. The settings schema existed but the page never wired useQuery/useMutation for reading/saving those values. Root cause: the spec review identified the need for configurable settings, but implementation focused on the backup actions and skipped the settings form. Prevention: when a page is linked to a settings category, always cross-check that every field in the category schema has a corresponding UI control.
