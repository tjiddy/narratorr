---
scope: [scope/backend]
files: [src/server/services/backup.service.ts]
issue: 382
source: spec-review
date: 2026-03-15
---
Spec's VACUUM INTO fallback note suggested charset whitelist validation (alphanumeric, hyphens, dots, path separators) but this would reject valid Windows paths with drive-letter colons (`C:\...`) and spaces. Root cause: `/elaborate` didn't consider cross-platform path constraints when proposing validation rules. When specifying path validation, always consider Windows drive letters, spaces, and UNC paths.
