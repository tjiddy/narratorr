---
scope: [scope/frontend]
files: [src/client/pages/settings/ProcessingSettingsSection.tsx, src/client/components/settings/FormField.tsx]
issue: 433
source: review
date: 2026-03-17
---
Reviewer caught that ProcessingSettingsSection was named in the first-wave FormField adoption surface but was only partially migrated (constants moved, but input patterns not converted). Missed because the plan focused on the three existing consumer files (DownloadClientForm, IndexerCard, NotifierCardForm) and treated ProcessingSettingsSection as "label constants only." The spec listed it as a first-wave target and that should have triggered full FormField adoption for compatible fields. Prevention: when the spec names specific files as adoption targets, verify each named file is fully converted before marking the AC as complete.
